import type { PublicCorrectiveAction } from '../corrective-actions';
import type { PublicIncident } from '../incidents';
import type { PublicOperationalDetailEvidence } from '../operational-detail-evidence';
import type { PublicOperationalDetailFindingRework } from '../operational-detail-finding-rework';
import type { PublicOperationalDetailReviewHistory } from '../operational-detail-review-history';
import type {
  PublicPermitToWorkApproval,
  PublicPermitToWorkLifecycle,
} from '../permit-to-work-register';
import type { PublicScheduledOperationLineage } from '../scheduled-operation-lineage';
import type {
  PublicIncidentReadinessDatasetRow,
  PublicPatrolDatasetRow,
  PublicSecurityFindingDatasetRow,
  PublicShiftHandoverDatasetRow,
} from '../security-reports';
import type { PublicWorkOrderSlaRegister } from '../work-order-sla-register';
import type {
  ReportingExportColumn,
  ReportingExportKpiValue,
  ReportingExportTable,
} from './reporting-export.types';

/**
 * R10 — bounded Reporting projections for the core operational journey and
 * exception datasets.
 *
 * This file is the R10 projection seam. It holds ONLY the projections R10
 * adds; the R01–R09 projections stay in `reporting-export.projections.ts`
 * and `reporting-export.management-projections.ts` and are not moved or
 * refactored here. The local `table()` helper and column-type constants
 * follow the exact precedent already set by
 * `reporting-export.management-projections.ts`, which is likewise a
 * self-contained second projection file over the shared envelope types.
 *
 * WHAT THIS FILE IS NOT
 * ---------------------
 *   - It performs NO calculation. No sums, rates, thresholds, day counts,
 *     or date arithmetic. Every value is copied verbatim from the owning
 *     domain's published output.
 *   - It owns NO lifecycle, due-date, or overdue authority. In particular
 *     it never derives `dueState`, `isOverdue`, days overdue, or any
 *     MET / MISSED / ON_TRACK / OVERDUE outcome. Those are produced by the
 *     corrective-action domain (`resolveCorrectiveActionDueStatus`, consumed
 *     through `toPublicCorrectiveAction`) and are copied here unchanged.
 *     `CORRECTIVE_ACTION_DUE_STATES` remains the domain's vocabulary; this
 *     file declares no competing one.
 *   - It creates no second read model and no new SQL. The registry adapter
 *     calls the existing governed `listCorrectiveActions()` read.
 */

const STRING = 'STRING' as const;
const NUMBER = 'NUMBER' as const;
const DATE = 'DATE' as const;
const BOOLEAN = 'BOOLEAN' as const;

function table(
  key: string,
  label: string,
  columns: ReportingExportColumn[],
  rows: ReportingExportTable['rows'],
): ReportingExportTable {
  return { key, label, columns, rows, rowCount: rows.length };
}

/**
 * R10 PART 02 — CORRECTIVE_ACTION projection.
 *
 * Grain: exactly one export row per authoritative `PublicCorrectiveAction`
 * returned by `listCorrectiveActions()`. The projection never fans out, so
 * the row count is always `source.length`.
 *
 * Exactly ONE table (`correctiveAction`) is emitted and `kpis` is
 * deliberately empty — a corrective-action export carries no headline
 * figures and this projection must not calculate any. Because the response
 * holds a single table, the generic renderer's sole-table behaviour is
 * sufficient: no `tableKey` is required and no `csvDefaultTableKey` exists
 * for this dataset.
 *
 * Field provenance (all authoritative, none reconstructed):
 *   - `correctiveActionId` is the corrective action's OWN id, published by
 *     the domain as `PublicCorrectiveAction.id` ("a child, not a
 *     specialization"). The export column is named for the grain it
 *     identifies; the value is copied, not invented.
 *   - `dueState` and `isOverdue` are copied from the domain's nested
 *     `dueStatus` projection verbatim. `dueStatus.daysUntilDue` is NOT
 *     exposed: it is a derived day count and is outside this contract.
 *   - `clientId`, `buildingId`, `incidentNumber`, `incidentType` and
 *     `incidentStatus` are the Incident context the owning domain already
 *     resolved read-only from BE-21A. Reporting never re-resolves or
 *     re-infers them, and never infers client/building from any unrelated
 *     record. The domain's INNER incident relation is preserved by calling
 *     the owning read: no incident, no row.
 *   - `verifiedByUserId` is the BE-21J verification actor as published.
 *     The verification and responsibility CHILD histories
 *     (`corrective_action_verifications`, `corrective_action_responsibilities`)
 *     are separate grains and are deliberately NOT joined or flattened here.
 *   - `updatedAt` is the row's last-update instant. It is NOT a lifecycle
 *     stage-entry timestamp and must not be read as one; the authoritative
 *     stage instants (`proposedAt`, `approvedAt`, `startedAt`,
 *     `completedAt`, `verifiedAt`, `statusChangedAt`) are owned by the
 *     domain, and only `statusChangedAt` is part of this contract.
 *   - A COMPLETED action is never relabelled OVERDUE by Reporting: the
 *     domain's own rule ("a COMPLETED action is never OVERDUE") is carried
 *     through untouched, including its MET / MISSED historical semantics.
 */
export function projectCorrectiveAction(source: PublicCorrectiveAction[]): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  return {
    kpis: [],
    tables: [
      table(
        'correctiveAction',
        'Corrective Action',
        [
          { key: 'correctiveActionId', label: 'Corrective Action Id', type: STRING },
          { key: 'incidentId', label: 'Incident Id', type: STRING },
          { key: 'incidentNumber', label: 'Incident No', type: STRING },
          { key: 'incidentType', label: 'Incident Type', type: STRING },
          { key: 'incidentStatus', label: 'Incident Status', type: STRING },
          { key: 'clientId', label: 'Client Id', type: STRING },
          { key: 'buildingId', label: 'Building Id', type: STRING },
          { key: 'actionType', label: 'Action Type', type: STRING },
          { key: 'description', label: 'Description', type: STRING },
          { key: 'status', label: 'Status', type: STRING },
          { key: 'statusChangedAt', label: 'Status Changed At', type: DATE },
          { key: 'dueDate', label: 'Due Date', type: DATE },
          { key: 'dueState', label: 'Due State', type: STRING },
          { key: 'isOverdue', label: 'Is Overdue', type: BOOLEAN },
          { key: 'dueDateSetAt', label: 'Due Date Set At', type: DATE },
          { key: 'dueDateSetByUserId', label: 'Due Date Set By User Id', type: STRING },
          { key: 'verifiedByUserId', label: 'Verified By User Id', type: STRING },
          { key: 'createdByUserId', label: 'Created By User Id', type: STRING },
          { key: 'createdAt', label: 'Created At', type: DATE },
          { key: 'updatedAt', label: 'Updated At', type: DATE },
        ],
        source.map((action) => ({
          correctiveActionId: action.id,
          incidentId: action.incidentId,
          incidentNumber: action.incidentNumber,
          incidentType: action.incidentType,
          incidentStatus: action.incidentStatus,
          clientId: action.clientId,
          buildingId: action.buildingId,
          actionType: action.actionType,
          description: action.description,
          status: action.status,
          statusChangedAt: action.statusChangedAt,
          dueDate: action.dueDate,
          // Copied from the domain's own derived deadline projection. Never
          // recomputed here, in the registry, or in any Reporting helper.
          dueState: action.dueStatus.dueState,
          isOverdue: action.dueStatus.isOverdue,
          dueDateSetAt: action.dueDateSetAt,
          dueDateSetByUserId: action.dueDateSetByUserId,
          verifiedByUserId: action.verifiedByUserId,
          createdByUserId: action.createdByUserId,
          createdAt: action.createdAt,
          updatedAt: action.updatedAt,
        })),
      ),
    ],
  };
}

/**
 * R10 PART 03 — OPERATIONAL_DETAIL_HISTORY `history=EVIDENCE` projection.
 *
 * A direct field-for-field re-presentation of the EXISTING R08 child contract
 * `PublicOperationalDetailEvidenceRow`. It is not a second semantic
 * representation of an evidence row: every column is copied verbatim from the
 * row the R08 evidence child already produced, NULLs preserved, and no field is
 * renamed, merged, split, derived, or enriched.
 *
 * GRAIN — exactly one export row per authoritative `evidence_submissions.id`.
 * The projection never aggregates and never deduplicates by execution, file,
 * hash, status or timestamp, so `rowCount === source.rows.length` always.
 *
 * NO CROSS-CHILD FAN-OUT — `reviews`, `findings` and `finding_rework_cycles`
 * are not joined here and no column from them appears. Each R08 child stays a
 * separate grain behind the `history` discriminator; PART 03 is EVIDENCE only.
 *
 * CONTENT BOUNDARY — metadata only, never the file. The R08 contract already
 * excludes `fileReference` (the backend storage key), any storage/filesystem
 * path, bucket, token, signed URL and file bytes, and this projection adds no
 * file metadata of its own. `contentSha256` is an integrity fact published by
 * the domain, not a locator.
 *
 * ATTRIBUTION — meanings are preserved exactly. `capturedAt` is a nullable
 * device TIME, never an actor. `submittedByUserId` means SUBMITTED BY only and
 * is never labelled Executor, Performed By, Completed By, Captured By, Responder
 * or Decision Actor. `createdAt` is the lineage sequence; `updatedAt` is MIXED
 * (it moves on status, retention AND integrity writes) and is not a stage-entry
 * timestamp.
 *
 * INTEGRITY / RETENTION — stored facts projected verbatim with no derivation.
 * `contentSha256` NULL means "not hashed", never "verified"; `lastIntegrityStatus`
 * is only meaningful together with `lastIntegrityCheckedAt`; `retainedUntil` NULL
 * means UNGOVERNED; `retentionPolicyCode` / `retentionDaysSnapshot` are a FROZEN
 * snapshot. No integrityVerified / isValid / isTamperProof / isAvailable /
 * isCompliant field exists or is computed here. `status` and `retentionState`
 * remain TWO INDEPENDENT stored dimensions and are never inferred from each
 * other, so withdrawn and disposed evidence stay visible as lineage.
 *
 * `kpis` is deliberately empty: this is a history grain, not a headline-figure
 * surface, and the projection calculates nothing — in particular it never
 * recomputes R04's operational ACTIVE-only `evidenceCount`, which is a different
 * population by design and is not required to equal this row count.
 */
export function projectOperationalDetailEvidence(
  source: PublicOperationalDetailEvidence,
): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  return {
    kpis: [],
    tables: [
      table(
        'operationalDetailEvidence',
        'Operational Detail Evidence',
        [
          { key: 'evidenceId', label: 'Evidence Id', type: STRING },
          { key: 'engine', label: 'Engine', type: STRING },
          { key: 'executionId', label: 'Execution Id', type: STRING },
          { key: 'clientId', label: 'Client Id', type: STRING },
          { key: 'evidenceType', label: 'Evidence Type', type: STRING },
          { key: 'mimeType', label: 'Mime Type', type: STRING },
          { key: 'originalFileName', label: 'Original File Name', type: STRING },
          { key: 'fileSize', label: 'File Size', type: NUMBER },
          { key: 'capturedAt', label: 'Captured At', type: DATE },
          { key: 'createdAt', label: 'Created At', type: DATE },
          { key: 'updatedAt', label: 'Updated At', type: DATE },
          { key: 'submittedByUserId', label: 'Submitted By User Id', type: STRING },
          { key: 'status', label: 'Status', type: STRING },
          { key: 'retentionState', label: 'Retention State', type: STRING },
          { key: 'evidenceRequirementId', label: 'Evidence Requirement Id', type: STRING },
          { key: 'contentSha256', label: 'Content Sha256', type: STRING },
          { key: 'contentHashedAt', label: 'Content Hashed At', type: DATE },
          { key: 'hashAlgorithm', label: 'Hash Algorithm', type: STRING },
          { key: 'lastIntegrityStatus', label: 'Last Integrity Status', type: STRING },
          { key: 'lastIntegrityCheckedAt', label: 'Last Integrity Checked At', type: DATE },
          { key: 'retentionPolicyCode', label: 'Retention Policy Code', type: STRING },
          { key: 'retentionDaysSnapshot', label: 'Retention Days Snapshot', type: NUMBER },
          { key: 'retentionAppliedAt', label: 'Retention Applied At', type: DATE },
          { key: 'retainedUntil', label: 'Retained Until', type: DATE },
          { key: 'retentionHold', label: 'Retention Hold', type: BOOLEAN },
          { key: 'purgedAt', label: 'Purged At', type: DATE },
        ],
        source.rows.map((row) => ({
          evidenceId: row.evidenceId,
          engine: row.engine,
          executionId: row.executionId,
          clientId: row.clientId,
          evidenceType: row.evidenceType,
          mimeType: row.mimeType,
          originalFileName: row.originalFileName,
          fileSize: row.fileSize,
          capturedAt: row.capturedAt,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          submittedByUserId: row.submittedByUserId,
          status: row.status,
          retentionState: row.retentionState,
          evidenceRequirementId: row.evidenceRequirementId,
          contentSha256: row.contentSha256,
          contentHashedAt: row.contentHashedAt,
          hashAlgorithm: row.hashAlgorithm,
          lastIntegrityStatus: row.lastIntegrityStatus,
          lastIntegrityCheckedAt: row.lastIntegrityCheckedAt,
          retentionPolicyCode: row.retentionPolicyCode,
          retentionDaysSnapshot: row.retentionDaysSnapshot,
          retentionAppliedAt: row.retentionAppliedAt,
          retainedUntil: row.retainedUntil,
          retentionHold: row.retentionHold,
          purgedAt: row.purgedAt,
        })),
      ),
    ],
  };
}
/**
 * R10 PART 04 — OPERATIONAL_DETAIL_HISTORY `history=FINDING_REWORK` projection.
 *
 * A direct field-for-field re-presentation of the EXISTING R08 child contract
 * `PublicOperationalDetailFindingReworkRow`. It is not a second semantic
 * representation of a rework cycle: every column is copied verbatim from the row
 * the R08 finding-rework child already produced, NULLs preserved, and no field is
 * renamed, merged, split, derived, or enriched.
 *
 * GRAIN — exactly one export row per authoritative `finding_rework_cycles.id`.
 * The grain is the CYCLE, never the finding: a finding legitimately carries many
 * historical cycles, so the projection never aggregates, never collapses multiple
 * cycles and never deduplicates by `findingId`, `executionId`, `triggerReviewId`
 * or timestamp. `rowCount === source.rows.length` always.
 *
 * NO CROSS-CHILD FAN-OUT — `evidence_submissions`, `reviews` and the R08 evidence
 * / review-history children are NOT joined here and no column from them appears.
 * No evidenceCount, evidenceIds, verification decision, reviewer or reviewedAt is
 * added. Each R08 child stays a separate grain behind the `history` discriminator.
 *
 * LIFECYCLE — `status` is one of exactly two stored literals, REQUESTED and
 * RESUBMITTED, copied verbatim. RESUBMITTED means ONLY "resubmitted from this
 * rework cycle": it is never accepted, approved, verified, closed or completed,
 * and no derived lifecycle classification (OPEN / CLOSED / ACTIVE / TERMINAL /
 * SUCCESSFUL) is computed here because none is persisted.
 *
 * ATTRIBUTION — `requestedByUserId` is REWORK REQUESTED BY and
 * `resubmittedByUserId` is RESUBMITTED BY. Those are the ONLY two persisted cycle
 * actors and neither is an executor, so no column is labelled Executed By,
 * Performed By, Actual Executor, Completed By or Fixed By. The actor of a notes
 * edit is not persisted on the cycle at all and is therefore not exposed.
 *
 * TRIGGER REVIEW — `triggerReviewId` keeps its exact R08 meaning: the review that
 * CAUSED this cycle. It is never the re-verification of the resubmission, so it is
 * not renamed verificationReviewId, reverificationReviewId, acceptanceReviewId or
 * latestReviewId — each of those would assert a relation the schema does not store.
 *
 * REWORK NOTES — `reworkNotes` is a single MUTABLE, status-dependent column that
 * `markResubmitted` OVERWRITES, so the pre-resubmission value is NOT preserved and
 * is UNAVAILABLE. It is exposed verbatim and is never labelled original notes,
 * request notes, resubmission notes, resolution or correction result, and is never
 * parsed to derive a status or an outcome. `reason` is the separate STABLE
 * instruction persisted at request time and is likewise exposed verbatim.
 *
 * TWO BUILDING FACTS — `parentBuildingId` (the R04 building resolved for the
 * parent) and `findingBuildingId` (`findings.building_id` verbatim) are BOTH
 * preserved as distinct columns. They may legitimately differ, so they are never
 * collapsed, COALESCEd, compared, or used as a fallback for one another, and no
 * buildingMismatch / sameBuilding / isBuildingConsistent interpretation is added.
 *
 * TIMESTAMPS — `requestedAt` and `resubmittedAt` are the authoritative lifecycle
 * timestamps. `updatedAt` is MUTABLE (it moves on notes edits AND on resubmission)
 * so it is NOT a lineage timestamp: nothing here orders by it or infers a
 * stage-entry time from it.
 *
 * `kpis` is deliberately empty: this is a history grain, not a headline-figure
 * surface, and the projection calculates nothing — in particular no reworkCount or
 * latestRework* figure, which belong to R02 FINDING_REGISTER's finding grain.
 */
export function projectOperationalDetailFindingRework(
  source: PublicOperationalDetailFindingRework,
): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  return {
    kpis: [],
    tables: [
      table(
        'operationalDetailFindingRework',
        'Operational Detail Finding Rework',
        [
          { key: 'reworkCycleId', label: 'Rework Cycle Id', type: STRING },
          { key: 'engine', label: 'Engine', type: STRING },
          { key: 'executionId', label: 'Execution Id', type: STRING },
          { key: 'findingId', label: 'Finding Id', type: STRING },
          { key: 'clientId', label: 'Client Id', type: STRING },
          { key: 'parentBuildingId', label: 'Parent Building Id', type: STRING },
          { key: 'findingBuildingId', label: 'Finding Building Id', type: STRING },
          { key: 'status', label: 'Status', type: STRING },
          { key: 'reason', label: 'Reason', type: STRING },
          { key: 'reworkNotes', label: 'Rework Notes', type: STRING },
          { key: 'requestedByUserId', label: 'Requested By User Id', type: STRING },
          { key: 'requestedAt', label: 'Requested At', type: DATE },
          { key: 'resubmittedByUserId', label: 'Resubmitted By User Id', type: STRING },
          { key: 'resubmittedAt', label: 'Resubmitted At', type: DATE },
          { key: 'triggerReviewId', label: 'Trigger Review Id', type: STRING },
          { key: 'createdAt', label: 'Created At', type: DATE },
          { key: 'updatedAt', label: 'Updated At', type: DATE },
        ],
        source.rows.map((row) => ({
          reworkCycleId: row.reworkCycleId,
          engine: row.engine,
          executionId: row.executionId,
          findingId: row.findingId,
          clientId: row.clientId,
          parentBuildingId: row.parentBuildingId,
          findingBuildingId: row.findingBuildingId,
          status: row.status,
          reason: row.reason,
          reworkNotes: row.reworkNotes,
          requestedByUserId: row.requestedByUserId,
          requestedAt: row.requestedAt,
          resubmittedByUserId: row.resubmittedByUserId,
          resubmittedAt: row.resubmittedAt,
          triggerReviewId: row.triggerReviewId,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
      ),
    ],
  };
}
/**
 * R10 PART 05 — OPERATIONAL_DETAIL_HISTORY `history=REVIEW` projection.
 *
 * A direct field-for-field re-presentation of the EXISTING R08 child contract
 * `PublicOperationalDetailReviewHistoryRow`. It is not a second semantic
 * representation of a review: every column is copied verbatim from the row the R08
 * execution review-history child already produced, NULLs preserved, and no field is
 * renamed, merged, split, derived, normalized or enriched.
 *
 * GRAIN — exactly one export row per authoritative `reviews.id`. This is FULL review
 * history, so the projection never narrows to a latest review, a latest COMPLETED
 * review, one row per execution or one row per decision, and never aggregates,
 * collapses or deduplicates. Several reviews of one execution all survive, so
 * `rowCount === source.rows.length` always.
 *
 * BOTH STATUSES INCLUDED — `status` is one of exactly two stored literals, PENDING
 * and COMPLETED, copied verbatim from the reviews authority. PENDING rows are part
 * of this history and are never filtered out: nobody has decided anything on a
 * PENDING row, so a COMPLETED-only narrowing would silently delete live lineage.
 * No Reporting-local status vocabulary is declared and no derived lifecycle
 * classification (OPEN / CLOSED / ACTIVE / VERIFIED / ACCEPTED / FAILED) exists.
 *
 * DECISION — `decision` is copied verbatim through the reused shared reviews
 * authority and is NULL for every PENDING row, where NULL is MEANINGFUL. It is never
 * coerced to PENDING, UNDECIDED, NONE, UNKNOWN or N/A, never normalized to
 * PASS / FAIL / SUCCESS / VERIFIED / ACCEPTED, never bucketed, and never turned into
 * a boolean approval.
 *
 * REVIEWER IS NOT A DECISION ACTOR — `reviewerUserId` records the user stored when
 * the review was OPENED and is never rewritten. The user who SUBMITTED a decision is
 * NOT persisted anywhere, so this projection exposes no decision actor and invents
 * none: the column is labelled Reviewer, and never Decided By, Approved By, Rejected
 * By, Verified By, Decision Actor, Executor, Performed By or Completed By. Because
 * PENDING rows are included and no decision actor exists, this is review history and
 * must never be framed as a verification audit trail.
 *
 * NOTES — `reviews.notes` is MUTABLE and the completion path may overwrite the prior
 * value, which is NOT preserved anywhere in the database and is therefore
 * UNAVAILABLE. The current persisted value is exposed verbatim and is never
 * reconstructed, inferred, trimmed, parsed or summarized, and is never labelled
 * Original Notes, Initial Notes, Original Review Notes, Rejection Notes or Decision
 * Notes — notes are writable at open time, before any decision exists, so they are
 * not decision-specific by schema.
 *
 * TIMESTAMPS — `createdAt` is the only immutable timestamp and is the child's
 * ordering authority. `reviewedAt` is the persisted review-completion time and is
 * NULL until completion. `updatedAt` moves on every completion write, so it is a
 * record fact only: it is never promoted to a lineage authority, never used as the
 * review-completion time and never used to infer a decision time. Nothing here
 * re-orders rows.
 *
 * BUILDING — `reviews` stores NO building_id, so `parentBuildingId` (the R04
 * building resolved for the parent execution) is the ONLY building fact. No
 * review-level building scope is invented and no second building column is added.
 *
 * TARGET BOUNDARY — this history stays execution-bound. The child binds
 * `reviews.target_type` to an R07 engine literal, so the other shared review targets
 * (FINDING, WORK_ORDER, VENDOR_WORK, UTILITY_ABNORMAL_CONSUMPTION, PERMIT_APPLICATION,
 * DOCUMENT, DOCUMENT_VERSION, CORRECTIVE_ACTION) are structurally unreachable and no
 * column here widens that predicate.
 *
 * NO CROSS-CHILD FAN-OUT — `evidence_submissions`, `findings` and
 * `finding_rework_cycles` are NOT joined here, and no evidenceCount, findingCount or
 * reworkCount is added. Each R08 child stays a separate grain behind the `history`
 * discriminator.
 *
 * `kpis` is deliberately empty: this is a history grain, not a headline-figure
 * surface, and the projection calculates nothing — no reviewCount, isLatest,
 * isVerified, isApproved, verificationResult or awaitingVerification.
 */
export function projectOperationalDetailReviewHistory(
  source: PublicOperationalDetailReviewHistory,
): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  return {
    kpis: [],
    tables: [
      table(
        'operationalDetailReviewHistory',
        'Operational Detail Review History',
        [
          { key: 'reviewId', label: 'Review Id', type: STRING },
          { key: 'engine', label: 'Engine', type: STRING },
          { key: 'executionId', label: 'Execution Id', type: STRING },
          { key: 'clientId', label: 'Client Id', type: STRING },
          { key: 'parentBuildingId', label: 'Parent Building Id', type: STRING },
          { key: 'status', label: 'Status', type: STRING },
          { key: 'decision', label: 'Decision', type: STRING },
          { key: 'reviewerUserId', label: 'Reviewer User Id', type: STRING },
          { key: 'notes', label: 'Notes', type: STRING },
          { key: 'createdAt', label: 'Created At', type: DATE },
          { key: 'reviewedAt', label: 'Reviewed At', type: DATE },
          { key: 'updatedAt', label: 'Updated At', type: DATE },
        ],
        source.rows.map((row) => ({
          reviewId: row.reviewId,
          engine: row.engine,
          executionId: row.executionId,
          clientId: row.clientId,
          parentBuildingId: row.parentBuildingId,
          status: row.status,
          decision: row.decision,
          reviewerUserId: row.reviewerUserId,
          notes: row.notes,
          createdAt: row.createdAt,
          reviewedAt: row.reviewedAt,
          updatedAt: row.updatedAt,
        })),
      ),
    ],
  };
}
/**
 * R10 PART 08 — WORK_ORDER_SLA projection.
 *
 * A direct field-for-field re-presentation of the completed register contract
 * `PublicWorkOrderSlaRow`. Every column is copied verbatim from the row the
 * work-order-sla-register read model already produced, NULLs preserved, and nothing
 * is renamed, merged, split, derived, normalized or enriched.
 *
 * GRAIN — exactly one export row per `sla_clocks.id`. A Work Order therefore
 * legitimately produces up to two rows, RESPONSE and RESOLUTION, because status,
 * breach, pause, target, elapsed and escalation are clock-level facts. Repeated
 * `workOrderId` values across rows are expected and correct: the projection never
 * collapses, aggregates, deduplicates or groups by `workOrderId` or `appliedSlaId`,
 * and never chooses a "current" or "primary" clock, so
 * `rowCount === source.rows.length` always.
 *
 * BREACH — `breachedAt` is the persisted breach truth copied unchanged. NULL means
 * never breached. No breach is inferred here, no approaching-breach field or
 * threshold exists, and no compliance, lateness or bucket classification is derived.
 *
 * ELAPSED — `effectiveElapsedMilliseconds` is a CURRENT-ONLY read-time value measured
 * at the envelope's `asOf` instant. It is labelled Effective Elapsed Milliseconds and
 * is NEVER presented as breach duration, overdue duration, SLA violation duration,
 * time-to-breach or a historical/final elapsed snapshot, because it is none of those.
 *
 * PAUSE — `isPaused`, `pauseCount` and `totalPausedMilliseconds` stay three separate
 * factual fields describing persisted pause intervals for THIS clock. They are never
 * combined into a single pause state and never used to derive a status. The
 * RESOLUTION-only pause DEDUCTION is a rule of the owning SLA authority, applied in
 * its repository; this projection neither applies nor reverses nor normalizes it.
 *
 * ESCALATION — `escalationCount` plus the three `latestEscalation*` fields are bounded
 * aggregate and latest facts only. `latestEscalationStatus` is the status of the single
 * latest escalation ACTION and is never a current SLA status, and no full escalation
 * timeline is emitted here. No recipient identity is exposed.
 *
 * WORK ORDER ENRICHMENT — `workOrderNumber` and `workOrderStatus` are LEFT-JOIN
 * enrichment pinned to structural client and building equality in the register, so
 * both are legitimately nullable and are copied through as NULL rather than
 * substituted, coalesced or back-filled from any other row.
 *
 * Exactly ONE table (`workOrderSla`) is emitted and `kpis` is deliberately empty: no
 * breach rate, response or resolution compliance percentage, average elapsed, average
 * pause, escalation rate or near-breach count is calculated. Because the response holds
 * a single table, the generic renderer's sole-table behaviour is sufficient — no
 * `tableKey` is required and no `csvDefaultTableKey` exists for this dataset.
 */
export function projectWorkOrderSla(source: PublicWorkOrderSlaRegister): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  return {
    kpis: [],
    tables: [
      table(
        'workOrderSla',
        'Work Order SLA',
        [
          { key: 'appliedSlaId', label: 'Applied Sla Id', type: STRING },
          { key: 'workOrderId', label: 'Work Order Id', type: STRING },
          { key: 'workOrderNumber', label: 'Work Order Number', type: STRING },
          { key: 'workOrderStatus', label: 'Work Order Status', type: STRING },
          { key: 'clientId', label: 'Client Id', type: STRING },
          { key: 'buildingId', label: 'Building Id', type: STRING },
          { key: 'slaDefinitionId', label: 'Sla Definition Id', type: STRING },
          { key: 'definitionCode', label: 'Definition Code', type: STRING },
          { key: 'operationalType', label: 'Operational Type', type: STRING },
          { key: 'definitionWorkType', label: 'Definition Work Type', type: STRING },
          { key: 'definitionPriority', label: 'Definition Priority', type: STRING },
          { key: 'workOrderWorkType', label: 'Work Order Work Type', type: STRING },
          { key: 'workOrderPriority', label: 'Work Order Priority', type: STRING },
          { key: 'responseTargetMinutes', label: 'Response Target Minutes', type: NUMBER },
          { key: 'resolutionTargetMinutes', label: 'Resolution Target Minutes', type: NUMBER },
          { key: 'definitionEffectiveFrom', label: 'Definition Effective From', type: DATE },
          { key: 'definitionEffectiveTo', label: 'Definition Effective To', type: DATE },
          { key: 'appliedAt', label: 'Applied At', type: DATE },
          { key: 'slaClockId', label: 'Sla Clock Id', type: STRING },
          { key: 'clockType', label: 'Clock Type', type: STRING },
          { key: 'targetMinutes', label: 'Target Minutes', type: NUMBER },
          { key: 'startedAt', label: 'Started At', type: DATE },
          { key: 'clockStatus', label: 'Clock Status', type: STRING },
          { key: 'satisfiedAt', label: 'Satisfied At', type: DATE },
          { key: 'terminatedAt', label: 'Terminated At', type: DATE },
          { key: 'breachedAt', label: 'Breached At', type: DATE },
          { key: 'isPaused', label: 'Paused', type: BOOLEAN },
          { key: 'pauseCount', label: 'Pause Count', type: NUMBER },
          { key: 'totalPausedMilliseconds', label: 'Total Paused Milliseconds', type: NUMBER },
          { key: 'effectiveElapsedMilliseconds', label: 'Effective Elapsed Milliseconds', type: NUMBER },
          { key: 'escalationCount', label: 'Escalation Count', type: NUMBER },
          { key: 'latestEscalationLevel', label: 'Latest Escalation Level', type: NUMBER },
          { key: 'latestEscalationStatus', label: 'Latest Escalation Status', type: STRING },
          { key: 'latestEscalationTriggeredAt', label: 'Latest Escalation Triggered At', type: DATE },
        ],
        source.rows.map((row) => ({
          appliedSlaId: row.appliedSlaId,
          workOrderId: row.workOrderId,
          workOrderNumber: row.workOrderNumber,
          workOrderStatus: row.workOrderStatus,
          clientId: row.clientId,
          buildingId: row.buildingId,
          slaDefinitionId: row.slaDefinitionId,
          definitionCode: row.definitionCode,
          operationalType: row.operationalType,
          definitionWorkType: row.definitionWorkType,
          definitionPriority: row.definitionPriority,
          workOrderWorkType: row.workOrderWorkType,
          workOrderPriority: row.workOrderPriority,
          responseTargetMinutes: row.responseTargetMinutes,
          resolutionTargetMinutes: row.resolutionTargetMinutes,
          definitionEffectiveFrom: row.definitionEffectiveFrom,
          definitionEffectiveTo: row.definitionEffectiveTo,
          appliedAt: row.appliedAt,
          slaClockId: row.slaClockId,
          clockType: row.clockType,
          targetMinutes: row.targetMinutes,
          startedAt: row.startedAt,
          clockStatus: row.clockStatus,
          satisfiedAt: row.satisfiedAt,
          terminatedAt: row.terminatedAt,
          breachedAt: row.breachedAt,
          isPaused: row.isPaused,
          pauseCount: row.pauseCount,
          totalPausedMilliseconds: row.totalPausedMilliseconds,
          effectiveElapsedMilliseconds: row.effectiveElapsedMilliseconds,
          escalationCount: row.escalationCount,
          latestEscalationLevel: row.latestEscalationLevel,
          latestEscalationStatus: row.latestEscalationStatus,
          latestEscalationTriggeredAt: row.latestEscalationTriggeredAt,
        })),
      ),
    ],
  };
}
/**
 * R10 PART 11 — SCHEDULED_OPERATION_LINEAGE projection.
 *
 * A direct field-for-field re-presentation of the completed read-model contract
 * `PublicScheduledOperationLineageRow`. All 24 columns are copied verbatim in the
 * authoritative declaration order, NULLs preserved, and nothing is renamed, merged,
 * split, derived, normalized or enriched.
 *
 * GRAIN — exactly one export row per `generated_tasks.id`, which is the row identity.
 * A schedule definition therefore legitimately contributes MANY rows (one per generated
 * occurrence), and repeated `scheduleDefinitionId`, `status`, `assigneeType`,
 * `checklistExecutionId` or `formInstanceId` values across rows are expected and correct:
 * the projection never collapses, aggregates, deduplicates or groups by any of them, and
 * introduces no universal lineage grouping, so `rowCount === source.rows.length` always.
 *
 * TASK IDENTITY — `generatedTaskId` is the generated task's own identity. There is no
 * separate `tasks` table and no `generated_tasks.task_id` column, so no `taskId` alias is
 * emitted and none is invented for convenience.
 *
 * EXECUTION BINDINGS — `checklistExecutionId` and `formInstanceId` stay two separate
 * columns, each 0..1 by its own partial unique index in the owning schema. They are never
 * merged into a generic `executionId`, and no engine, source or binding-type field is
 * inferred from whichever happens to be non-NULL. Only the bound ids are presented: no
 * execution status, timestamp, response or actor is read, so no execution history is
 * fanned out here.
 *
 * ASSIGNMENT — every assignment column describes who the task is ASSIGNED to, never who
 * executed it. Labels stay assignment-safe (Assignee Type, Assigned Workforce, Assigned
 * Team) and no Executor, Executed By, Performed By or Completed By column exists.
 * `assignedWorkforceName` and `assignedTeamName` are LIVE/CURRENT reference-table names,
 * exactly as the read model sourced them; the schema persists no snapshot name, so they
 * are never labelled historical or as-of names.
 *
 * RECURRENCE — persisted 0..1 TOTAL lineage per schedule definition, enforced by
 * `recurrence_schedule_unique UNIQUE(schedule_definition_id)`. It is presented as the
 * plain factual value it is: never a latest recurrence, never a current recurrence
 * version, never a recurrence history, and there is no `recurrenceCount`,
 * `recurrenceVersion` or `latestRecurrence*` column because the authoritative row has
 * none. An INACTIVE recurrence is a factual lineage value and is NOT filtered out here.
 *
 * `recurrenceDaysOfWeek` is the one non-scalar authoritative value (`INTEGER[]`). The
 * governed renderers reject nested cell values (`UNSUPPORTED_CELL_VALUE`), so it is
 * flattened to a comma-joined STRING following the existing house precedent in
 * `reporting-export.management-projections.ts` (`availableActions`, `buildingIds`). This
 * is a presentation serialization only: the persisted weekday numbers are unchanged, in
 * order, and a NULL stays NULL rather than becoming an empty string.
 *
 * NO DERIVATION — no missed, overdue, late, on-time, dueBefore, graceMinutes, breach or
 * schedule-compliance value is computed, and `occurrenceAt` is presented as the persisted
 * planned occurrence instant it is, never compared against anything. `status` stays the
 * persisted generated-task status and is never reinterpreted as a timeliness outcome.
 *
 * Exactly ONE table (`scheduledOperationLineage`) is emitted and `kpis` is deliberately
 * empty: no scheduled, completed, missed or overdue count and no completion, on-time,
 * assignment or execution rate is calculated. Because the response holds a single table,
 * the generic renderer's sole-table behaviour is sufficient — no `tableKey` is required
 * and no `csvDefaultTableKey` exists for this dataset.
 */
export function projectScheduledOperationLineage(source: PublicScheduledOperationLineage): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  return {
    kpis: [],
    tables: [
      table(
        'scheduledOperationLineage',
        'Scheduled Operation Lineage',
        [
          { key: 'generatedTaskId', label: 'Generated Task Id', type: STRING },
          { key: 'clientId', label: 'Client Id', type: STRING },
          { key: 'buildingId', label: 'Building Id', type: STRING },
          { key: 'scheduleDefinitionId', label: 'Schedule Definition Id', type: STRING },
          { key: 'scheduleDefinitionCode', label: 'Schedule Definition Code', type: STRING },
          { key: 'scheduleDefinitionName', label: 'Schedule Definition Name', type: STRING },
          { key: 'scheduleDefinitionStatus', label: 'Schedule Definition Status', type: STRING },
          { key: 'status', label: 'Task Status', type: STRING },
          { key: 'occurrenceAt', label: 'Occurrence At', type: DATE },
          { key: 'generatedAt', label: 'Generated At', type: DATE },
          { key: 'checklistExecutionId', label: 'Checklist Execution Id', type: STRING },
          { key: 'formInstanceId', label: 'Form Instance Id', type: STRING },
          { key: 'assigneeType', label: 'Assignee Type', type: STRING },
          { key: 'assignedWorkforceProfileId', label: 'Assigned Workforce Profile Id', type: STRING },
          { key: 'assignedWorkforceName', label: 'Assigned Workforce', type: STRING },
          { key: 'assignedTeamId', label: 'Assigned Team Id', type: STRING },
          { key: 'assignedTeamName', label: 'Assigned Team', type: STRING },
          { key: 'recurrenceFrequency', label: 'Recurrence Frequency', type: STRING },
          { key: 'recurrenceInterval', label: 'Recurrence Interval', type: NUMBER },
          { key: 'recurrenceDaysOfWeek', label: 'Recurrence Days Of Week', type: STRING },
          { key: 'recurrenceDayOfMonth', label: 'Recurrence Day Of Month', type: NUMBER },
          { key: 'recurrenceStartDate', label: 'Recurrence Start Date', type: DATE },
          { key: 'recurrenceEndDate', label: 'Recurrence End Date', type: DATE },
          { key: 'recurrenceStatus', label: 'Recurrence Status', type: STRING },
        ],
        source.rows.map((row) => ({
          generatedTaskId: row.generatedTaskId,
          clientId: row.clientId,
          buildingId: row.buildingId,
          scheduleDefinitionId: row.scheduleDefinitionId,
          scheduleDefinitionCode: row.scheduleDefinitionCode,
          scheduleDefinitionName: row.scheduleDefinitionName,
          scheduleDefinitionStatus: row.scheduleDefinitionStatus,
          status: row.status,
          occurrenceAt: row.occurrenceAt,
          generatedAt: row.generatedAt,
          checklistExecutionId: row.checklistExecutionId,
          formInstanceId: row.formInstanceId,
          assigneeType: row.assigneeType,
          assignedWorkforceProfileId: row.assignedWorkforceProfileId,
          assignedWorkforceName: row.assignedWorkforceName,
          assignedTeamId: row.assignedTeamId,
          assignedTeamName: row.assignedTeamName,
          recurrenceFrequency: row.recurrenceFrequency,
          recurrenceInterval: row.recurrenceInterval,
          // The single non-scalar authoritative value, flattened per the existing house
          // precedent; the persisted weekday numbers are unchanged and NULL stays NULL.
          recurrenceDaysOfWeek: row.recurrenceDaysOfWeek ? row.recurrenceDaysOfWeek.join(',') : null,
          recurrenceDayOfMonth: row.recurrenceDayOfMonth,
          recurrenceStartDate: row.recurrenceStartDate,
          recurrenceEndDate: row.recurrenceEndDate,
          recurrenceStatus: row.recurrenceStatus,
        })),
      ),
    ],
  };
}

/**
 * R10 PART 14 — PERMIT_TO_WORK projection, LIFECYCLE view.
 *
 * ONE DATASET, TWO VIEWS — this is not a second dataset. The caller must send the
 * required `view` discriminator; there is no default and nothing is inferred from the
 * presence or absence of filters. The owning `permit-to-work-register` service selects
 * the repository query, so this projection receives an already-resolved, already-scoped
 * envelope and only decides presentation.
 *
 * GRAIN — exactly one export row per `permit_applications.id`, verbatim from
 * `PublicPermitToWorkLifecycle.rows`. The projection never fans out, never filters,
 * never sorts, never groups and never de-duplicates, so the row count is always
 * `source.rows.length`.
 *
 * SCOPE AND CLOCK — `buildingScope` and the `asOf` clock belong to the owning register
 * service and are forwarded through the adapter's `common` envelope untouched. This
 * projection reads no clock of its own and calls neither `new Date()` nor `Date.now()`.
 * The LIFECYCLE view's date authority is `permit_applications.requested_work_at`, owned
 * by the register; `dateFrom`/`dateTo` are echoed, never re-applied here.
 *
 * APPROVAL COUNTS ARE COUNTS ONLY — `approvalCount` and `pendingApprovalCount` are
 * aggregate totals published by the owning read model. They are labelled as counts and
 * nothing else: never as current approvals, next approvals, remaining approvals or
 * required approvals, and no approval sequence, stage or precedence is implied by them.
 * Consequently this view carries NO `approvalId`, `approvalStage`, `approvalType`,
 * `approvalStatus` or `assignedApproverUserId` column — those belong to the APPROVAL
 * grain, and a per-approval fact is never folded into the application row.
 *
 * STATUSES STAY SEPARATE — `applicationStatus`, `permitStatus`, `workLifecycleStatus`
 * and `validityStatus` are four distinct authoritative vocabularies and are copied
 * verbatim. They are never merged into one combined `status` column and never
 * reinterpreted: no missed, overdue, expired, breached or compliance outcome is computed
 * here, and `requestedWorkAt` is presented as the persisted requested instant, never
 * compared against anything.
 *
 * Exactly ONE table (`permitToWorkLifecycle`) is emitted and `kpis` is deliberately
 * empty: no application, submitted, cancelled, valid or approval total and no rate is
 * calculated. Because the response holds a single table, the generic renderer's
 * sole-table behaviour is sufficient — no `tableKey` is required and no
 * `csvDefaultTableKey` exists for this dataset.
 */
export function projectPermitToWorkLifecycle(source: PublicPermitToWorkLifecycle): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  return {
    kpis: [],
    tables: [
      table(
        'permitToWorkLifecycle',
        'Permit To Work Lifecycle',
        [
          { key: 'permitApplicationId', label: 'Permit Application Id', type: STRING },
          { key: 'permitId', label: 'Permit Id', type: STRING },
          { key: 'permitNumber', label: 'Permit Number', type: STRING },
          { key: 'clientId', label: 'Client Id', type: STRING },
          { key: 'buildingId', label: 'Building Id', type: STRING },
          { key: 'applicationStatus', label: 'Application Status', type: STRING },
          { key: 'permitStatus', label: 'Permit Status', type: STRING },
          { key: 'requestedWorkAt', label: 'Requested Work At', type: DATE },
          { key: 'submittedAt', label: 'Submitted At', type: DATE },
          { key: 'cancelledAt', label: 'Cancelled At', type: DATE },
          { key: 'createdAt', label: 'Created At', type: DATE },
          { key: 'workLifecycleStatus', label: 'Work Lifecycle Status', type: STRING },
          { key: 'workLifecycleStartedAt', label: 'Work Lifecycle Started At', type: DATE },
          { key: 'workLifecycleClosedAt', label: 'Work Lifecycle Closed At', type: DATE },
          { key: 'validityStatus', label: 'Validity Status', type: STRING },
          { key: 'validFrom', label: 'Valid From', type: DATE },
          { key: 'validUntil', label: 'Valid Until', type: DATE },
          { key: 'approvalCount', label: 'Approval Count', type: NUMBER },
          { key: 'pendingApprovalCount', label: 'Pending Approval Count', type: NUMBER },
        ],
        source.rows.map((row) => ({
          permitApplicationId: row.permitApplicationId,
          permitId: row.permitId,
          permitNumber: row.permitNumber,
          clientId: row.clientId,
          buildingId: row.buildingId,
          applicationStatus: row.applicationStatus,
          permitStatus: row.permitStatus,
          requestedWorkAt: row.requestedWorkAt,
          submittedAt: row.submittedAt,
          cancelledAt: row.cancelledAt,
          createdAt: row.createdAt,
          workLifecycleStatus: row.workLifecycleStatus,
          workLifecycleStartedAt: row.workLifecycleStartedAt,
          workLifecycleClosedAt: row.workLifecycleClosedAt,
          validityStatus: row.validityStatus,
          validFrom: row.validFrom,
          validUntil: row.validUntil,
          // Aggregate counts only. Never labelled current, next, remaining or required.
          approvalCount: row.approvalCount,
          pendingApprovalCount: row.pendingApprovalCount,
        })),
      ),
    ],
  };
}

/**
 * R10 PART 14 — PERMIT_TO_WORK projection, APPROVAL view.
 *
 * GRAIN — exactly one export row per `permit_approval_bindings.id`. This is a true 1:N
 * child of the permit application, so one permit legitimately contributes many approval
 * rows. They are NEVER collapsed, de-duplicated, grouped or folded back onto the
 * application row, and this view is never merged with LIFECYCLE into a universal permit
 * rowset. The projection never filters, never sorts and never re-orders: rows arrive in
 * the owning repository's deterministic order (`permit_approval_bindings.created_at`,
 * then its id) and stay in it.
 *
 * NO ELECTION AND NO PRECEDENCE — there is no current approval, no latest approval, no
 * next approval and no active approval, because none exists in the domain. No row is
 * ranked, elected or privileged here. `approvalStage` and `approvalType` are free-form
 * backend vocabulary carried as persisted values: the column order below is the
 * authoritative source field order, NOT a stage sequence, and no stage precedence,
 * ordering or workflow position is implied or computed.
 *
 * `approvalStatus` IS PROJECTED VERBATIM — the owning domain derives it in one place
 * (a PENDING review yields PENDING, otherwise the review decision). This projection
 * copies that value unchanged and does NOT rederive it, and does not offer a second
 * interpretation of `reviewStatus` or `decision`. All three stay as separate columns so
 * a consumer can see the authoritative derivation inputs without this file re-judging
 * them.
 *
 * ASSIGNMENT IS NOT ATTRIBUTION — `assignedApproverUserId` records who the approval was
 * ASSIGNED to, and `createdByUserId` records who created the binding. Neither is a
 * decision actor: the domain publishes no decision actor at all. Labels therefore stay
 * assignment-safe and there is no Decision By, Approved By, Rejected By, Decided By or
 * Responded By column anywhere in this projection.
 *
 * STATUSES STAY SEPARATE — `applicationStatus`, `permitStatus` and `approvalStatus` are
 * distinct authoritative vocabularies, copied verbatim and never merged into one
 * combined `status` column. `reviewedAt` is the review instant as published.
 *
 * NOTES — `notes` is the binding's current mutable note only, exactly as persisted. It
 * is never labelled a note history, and no historical or superseded note is
 * reconstructed here.
 *
 * SCOPE AND CLOCK — `buildingScope` and `asOf` belong to the owning register service and
 * are forwarded untouched. The APPROVAL view's date authority is
 * `permit_approval_bindings.created_at`, owned by the register; `dateFrom`/`dateTo` are
 * echoed, never re-applied, and this projection reads no clock of its own.
 *
 * Exactly ONE table (`permitToWorkApproval`) is emitted and `kpis` is deliberately
 * empty: no approval, pending, approved, rejected or rework count and no approval rate
 * is calculated. Because the response holds a single table, the generic renderer's
 * sole-table behaviour is sufficient — no `tableKey` is required and no
 * `csvDefaultTableKey` exists for this dataset.
 */
export function projectPermitToWorkApproval(source: PublicPermitToWorkApproval): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  return {
    kpis: [],
    tables: [
      table(
        'permitToWorkApproval',
        'Permit To Work Approval',
        [
          { key: 'approvalId', label: 'Approval Id', type: STRING },
          { key: 'permitApplicationId', label: 'Permit Application Id', type: STRING },
          { key: 'permitId', label: 'Permit Id', type: STRING },
          { key: 'permitNumber', label: 'Permit Number', type: STRING },
          { key: 'clientId', label: 'Client Id', type: STRING },
          { key: 'buildingId', label: 'Building Id', type: STRING },
          { key: 'approvalStage', label: 'Approval Stage', type: STRING },
          { key: 'approvalType', label: 'Approval Type', type: STRING },
          { key: 'reviewId', label: 'Review Id', type: STRING },
          { key: 'reviewStatus', label: 'Review Status', type: STRING },
          { key: 'decision', label: 'Decision', type: STRING },
          { key: 'approvalStatus', label: 'Approval Status', type: STRING },
          { key: 'reviewedAt', label: 'Reviewed At', type: DATE },
          { key: 'notes', label: 'Notes', type: STRING },
          { key: 'assignedApproverUserId', label: 'Assigned Approver User Id', type: STRING },
          { key: 'createdByUserId', label: 'Created By User Id', type: STRING },
          { key: 'createdAt', label: 'Created At', type: DATE },
          { key: 'applicationStatus', label: 'Application Status', type: STRING },
          { key: 'permitStatus', label: 'Permit Status', type: STRING },
        ],
        source.rows.map((row) => ({
          approvalId: row.approvalId,
          permitApplicationId: row.permitApplicationId,
          permitId: row.permitId,
          permitNumber: row.permitNumber,
          clientId: row.clientId,
          buildingId: row.buildingId,
          approvalStage: row.approvalStage,
          approvalType: row.approvalType,
          reviewId: row.reviewId,
          reviewStatus: row.reviewStatus,
          decision: row.decision,
          // Copied verbatim from the owning domain's single derivation. Never rederived.
          approvalStatus: row.approvalStatus,
          reviewedAt: row.reviewedAt,
          // The current mutable note only; never a note history.
          notes: row.notes,
          // Assignment, not attribution: never a decision actor.
          assignedApproverUserId: row.assignedApproverUserId,
          createdByUserId: row.createdByUserId,
          createdAt: row.createdAt,
          applicationStatus: row.applicationStatus,
          permitStatus: row.permitStatus,
        })),
      ),
    ],
  };
}

/**
 * R10 PART 15 — SECURITY_OPERATIONAL_DETAIL projection, source=PATROL.
 *
 * ONE DATASET, STAGED SOURCES — this is the PATROL projection of SECURITY_OPERATIONAL_DETAIL,
 * not a patrol dataset of its own. The caller must send the required `source` discriminator;
 * PART 15 implements PATROL only and the registry fails closed on every other declared value.
 *
 * GRAIN AND IDENTITY — exactly one export row per authoritative `PublicPatrolDatasetRow`
 * returned by the owning BE-12M security-report patrol read. The row identity is the pair
 * (taskId, patrolScheduleBindingId), and BOTH fields are projected. The patrol query joins
 * `generated_tasks` to `patrol_schedule_bindings` on `schedule_definition_id` alone, and
 * since CR-BE-RN16-PATROL-FIELD-01 PART 00 (migration 0354, which made
 * `patrol_schedule_bindings_schedule_active_unique` unique on `schedule_definition_id WHERE
 * status = 'ACTIVE'`) a schedule definition holds at most one ACTIVE binding, so one taskId
 * resolves to exactly one patrol route and cannot appear on more than one row. The
 * projection is unchanged by that: it still never filters, sorts, groups, de-duplicates,
 * ranks, elects or collapses, so the row count is always `source.length`. No DISTINCT,
 * GROUP BY, ROW_NUMBER or LATERAL selector exists anywhere in this path and no primary,
 * current, first or latest binding is chosen.
 *
 * NO DERIVED IDENTITY — `patrolScheduleBindingId` is the PART 14B additive field copied
 * VERBATIM. It is never derived from patrolRouteId, scheduleDefinitionId or taskId and never
 * synthesized into a composite string; the two factual identity fields stay separate columns.
 * `taskId` is the owning read's own field name and is projected as-is: no `generatedTaskId`
 * alias is introduced, and taskId is never reinterpreted as a schedule, route, execution or
 * binding identity.
 *
 * NO TIMELINESS ARITHMETIC — the existing Security KPI derives overdue as a status test
 * combined with `occurrence_at < asOf - graceMinutes`, and missed as that plus a NULL
 * started_at. None of that is reproduced here: `missed`, `isMissed`, `overdue`, `isOverdue`,
 * `dueBefore`, `graceMinutes`, `onTime`, `late`, `complianceStatus` and any KPI contribution
 * are absent, and no row is classified against a clock. `occurrenceAt`, `startedAt` and
 * `completedAt` are the persisted instants they are, never compared against anything, and
 * `status` remains the persisted generated-task status rather than a timeliness outcome.
 *
 * NOT A KPI CONTRIBUTOR LIST — this is the governed PATROL record list for the selected
 * period and Building context. It is NOT an exact contributor list for the MISSED or OVERDUE
 * patrol KPI and is never labelled as one. Relatedly, the patrol dataset filters a security
 * post with `COALESCE(psb.start_security_post_id, pr.start_security_post_id) = X` while the KPI
 * domain uses `(psb.start_security_post_id = X OR pr.start_security_post_id = X)`. That
 * divergence is owned by the security domain, is deliberately NOT reconciled here, and means a
 * security-post-filtered patrol list must not be presented as KPI contributor parity.
 *
 * `completedByUserId` is the persisted completion actor exactly as the owning read publishes
 * it; it is copied, not inferred, and no executor is derived for rows that have none.
 * `securityPostId`, `securityPostCode` and `securityPostName` stay nullable because the
 * authoritative COALESCE can yield no post. Every projected value is a scalar, so no
 * flattening convention is needed and the governed renderers accept all of them.
 *
 * Exactly ONE table (`securityOperationalPatrol`) is emitted and `kpis` is deliberately empty:
 * no patrol count, missed count, overdue count, completion rate or compliance rate is
 * calculated, and the existing Security KPI remains authoritative elsewhere. Because the
 * response holds a single table, the generic renderer's sole-table behaviour is sufficient — no
 * `tableKey` is required, and no `csvDefaultTableKey` exists for this dataset because later
 * PARTs will add further source-dependent table keys, making a dataset-wide default
 * inappropriate.
 */
export function projectSecurityOperationalPatrol(source: PublicPatrolDatasetRow[]): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  return {
    kpis: [],
    tables: [
      table(
        'securityOperationalPatrol',
        'Security Operational Patrol',
        [
          { key: 'taskId', label: 'Task Id', type: STRING },
          { key: 'patrolScheduleBindingId', label: 'Patrol Schedule Binding Id', type: STRING },
          { key: 'patrolRouteId', label: 'Patrol Route Id', type: STRING },
          { key: 'patrolRouteCode', label: 'Patrol Route Code', type: STRING },
          { key: 'patrolRouteName', label: 'Patrol Route Name', type: STRING },
          { key: 'securityPostId', label: 'Security Post Id', type: STRING },
          { key: 'securityPostCode', label: 'Security Post Code', type: STRING },
          { key: 'securityPostName', label: 'Security Post Name', type: STRING },
          { key: 'status', label: 'Task Status', type: STRING },
          { key: 'occurrenceAt', label: 'Occurrence At', type: DATE },
          { key: 'startedAt', label: 'Started At', type: DATE },
          { key: 'completedAt', label: 'Completed At', type: DATE },
          { key: 'completedByUserId', label: 'Completed By User Id', type: STRING },
        ],
        source.map((row) => ({
          taskId: row.taskId,
          // PART 14B additive identity field, copied verbatim: never derived and never merged
          // with taskId into a composite.
          patrolScheduleBindingId: row.patrolScheduleBindingId,
          patrolRouteId: row.patrolRouteId,
          patrolRouteCode: row.patrolRouteCode,
          patrolRouteName: row.patrolRouteName,
          securityPostId: row.securityPostId,
          securityPostCode: row.securityPostCode,
          securityPostName: row.securityPostName,
          // The persisted generated-task status. Never a missed/overdue/on-time outcome.
          status: row.status,
          occurrenceAt: row.occurrenceAt,
          startedAt: row.startedAt,
          completedAt: row.completedAt,
          completedByUserId: row.completedByUserId,
        })),
      ),
    ],
  };
}

/**
 * R10 PART 16 — SECURITY_OPERATIONAL_DETAIL / SHIFT_HANDOVER.
 *
 * A PURE re-presentation of the existing governed BE-12M shift-handover dataset read
 * (`securityReportService.getShiftHandoverDataset`). No shift-handover SQL is reproduced here,
 * `security_shift_handover_bindings` and `shift_handovers` are never queried from Reporting, and
 * no second read model is created.
 *
 * GRAIN — ONE Reporting row per ONE existing governed shift-handover dataset row. The owning read
 * selects from `security_shift_handover_bindings sshb` joined to `shift_handovers sh`, publishing
 * `sshb.id AS binding_id`, so the authoritative row identity is the BINDING id and is projected
 * verbatim as `bindingId`. No synthetic handover id is minted, no composite id string is
 * synthesized, and the two factual identity fields (`bindingId`, `shiftHandoverId`) stay separate
 * columns.
 *
 * `shiftHandoverId` is a related fact, not the row identity: one shift handover may be bound more
 * than once, so a repeated `shiftHandoverId` across several binding rows is PRESERVED as several
 * rows. There is no DISTINCT, GROUP BY, DISTINCT ON, ROW_NUMBER, LATERAL, LIMIT 1, MAX(timestamp)
 * or sort-and-first anywhere in this path, and no deduplication by shiftHandoverId, startSecurityPostId
 * or patrolRouteId. No latest, current, mostRecent, active or effective handover is elected —
 * Reporting exposes the authoritative existing rows and nothing else. The two LEFT JOINs in the
 * owning read resolve `security_posts` and `patrol_routes` by primary key, so they add code labels
 * without fanning the grain out.
 *
 * PERIOD SEMANTICS are the owning read's own and are preserved, not substituted: it bounds on
 * `sh.created_at` with a half-open range (`>= start`, `< end`) and orders by
 * `sh.created_at DESC, sshb.created_at DESC`. `handoverCreatedAt` is that persisted instant copied
 * as-is. Reporting creates no new date mode and never re-bounds on the binding's own created_at, a
 * shift start, a shift end or an updatedAt.
 *
 * STATUS — the authoritative row persists TWO distinct statuses and both are projected verbatim as
 * separate columns: `bindingStatus` (the binding's own status) and `handoverStatus` (the handover's
 * status). Neither is derived, merged, prioritized or relabeled, and no completed, accepted,
 * acknowledged, overdue, missed or pending value is inferred from timestamps or from the other
 * column. The owning read's `status` filter matches `sh.status`, i.e. the HANDOVER status, which is
 * documented rather than silently widened to also match the binding status.
 *
 * ACTOR SEMANTICS — the authoritative public row publishes NO actor field of any kind. There is no
 * creator, author, submittedBy, handoverBy, receiver or acknowledger column, so none is projected
 * and none is inferred: no user, workforce, guard or executor identity is attached to a handover
 * row here. Acknowledgement is represented only by the persisted `handoverStatus` value, never by a
 * derived actor or timestamp.
 *
 * FILTERS truthfully applied by the owning read are buildingId (scope, on the binding's own
 * building_id), securityPostId, patrolRouteId, status, dateFrom and dateTo. Note that this read
 * matches a security post by direct equality on `sshb.start_security_post_id`, whereas the PATROL
 * source uses `COALESCE(psb.start_security_post_id, pr.start_security_post_id)`. That difference is
 * owned by the security domain, is deliberately NOT reconciled here, and means the two sources must
 * not be presented as filtering security posts identically. Any other parsed field is ignored by
 * this read exactly as the existing dataset endpoint ignores it.
 *
 * `startSecurityPostId`, `startSecurityPostCode`, `patrolRouteId` and `patrolRouteCode` stay
 * nullable because the owning LEFT JOINs can yield no post and no route. Every projected value is a
 * scalar string, so no flattening convention is needed, nothing is JSON-serialized, and the
 * governed renderers accept all nine columns.
 *
 * Exactly ONE table (`securityOperationalShiftHandover`) is emitted and `kpis` is deliberately
 * empty: no handover count, completion rate, pending count, late-handover figure or shift
 * compliance metric is calculated. No `csvDefaultTableKey` exists for this dataset — it now has
 * source-dependent table keys (patrol vs shift handover), so a dataset-wide CSV default would be
 * wrong; OPERATIONAL_DETAIL remains the only metadata default holder.
 */
export function projectSecurityOperationalShiftHandover(
  source: PublicShiftHandoverDatasetRow[],
): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  return {
    kpis: [],
    tables: [
      table(
        'securityOperationalShiftHandover',
        'Security Operational Shift Handover',
        [
          { key: 'bindingId', label: 'Binding Id', type: STRING },
          { key: 'shiftHandoverId', label: 'Shift Handover Id', type: STRING },
          { key: 'startSecurityPostId', label: 'Start Security Post Id', type: STRING },
          { key: 'startSecurityPostCode', label: 'Start Security Post Code', type: STRING },
          { key: 'patrolRouteId', label: 'Patrol Route Id', type: STRING },
          { key: 'patrolRouteCode', label: 'Patrol Route Code', type: STRING },
          { key: 'bindingStatus', label: 'Binding Status', type: STRING },
          { key: 'handoverStatus', label: 'Handover Status', type: STRING },
          { key: 'handoverCreatedAt', label: 'Handover Created At', type: DATE },
        ],
        source.map((row) => ({
          // The authoritative row identity, copied verbatim: never synthesized and never merged
          // with shiftHandoverId into a composite.
          bindingId: row.bindingId,
          // A related fact that may legitimately repeat across binding rows. Never collapsed,
          // deduplicated or elected as "the" handover.
          shiftHandoverId: row.shiftHandoverId,
          startSecurityPostId: row.startSecurityPostId,
          startSecurityPostCode: row.startSecurityPostCode,
          patrolRouteId: row.patrolRouteId,
          patrolRouteCode: row.patrolRouteCode,
          // Two independently persisted statuses, kept separate. Neither is derived from the
          // other, from handoverCreatedAt, or relabeled as an acknowledgement outcome.
          bindingStatus: row.bindingStatus,
          handoverStatus: row.handoverStatus,
          handoverCreatedAt: row.handoverCreatedAt,
        })),
      ),
    ],
  };
}

/**
 * R10 PART 17 — SECURITY_OPERATIONAL_DETAIL / SECURITY_FINDING.
 *
 * A PURE re-presentation of the existing governed BE-12M security-finding dataset read
 * (`securityReportService.getSecurityFindingDataset`). No finding SQL is reproduced here, neither
 * `security_finding_links` nor `findings` is ever queried from Reporting, and no second finding
 * authority, repository, status vocabulary or lifecycle is created.
 *
 * THIS IS NOT THE R08 FINDING CHILD GRAIN AND NOT THE FINDING_REGISTER DATASET. The rows are the
 * Security Reports finding-link dataset only; Reporting performs no join to the R08 Finding child
 * histories, no join to FINDING_REGISTER, no universal finding join and no enrichment of any kind.
 * Nothing is merged across those grains and no relation is inferred from a shared finding id,
 * title, timestamp, post, route, building or user.
 *
 * GRAIN — ONE Reporting row per ONE existing governed security-finding dataset row. The owning read
 * selects from `security_finding_links sfl` joined to `findings f`, publishing `sfl.id AS link_id`,
 * so the authoritative row identity is the LINK id and is projected verbatim as `linkId`. No
 * synthetic identity is minted: there is no securityFindingKey, compositeFindingId,
 * findingReference or sourceFindingId, because the authoritative public row has no such field.
 *
 * `findingId` is a related fact, not the row identity: one finding may be linked to more than one
 * post or route, so a repeated `findingId` across several link rows is PRESERVED as several rows.
 * There is no DISTINCT, GROUP BY, DISTINCT ON, ROW_NUMBER, LATERAL, LIMIT 1, MAX(timestamp) or
 * sort-and-first anywhere in this path, and no deduplication by findingId, findingNumber,
 * sourcePostId or sourceRouteId. No latest, current, mostRecent, active or effective finding is
 * elected. The two LEFT JOINs resolve `security_posts` and `patrol_routes` by primary key, so they
 * add code labels without fanning the grain out.
 *
 * PERIOD SEMANTICS are the owning read's own and are preserved, not substituted: it bounds on the
 * finding's `reported_at` with a half-open range (`>= start`, `< end`) and orders by
 * `f.reported_at DESC, sfl.created_at DESC`. `reportedAt` is that persisted instant copied as-is.
 * Reporting creates no second date interpretation and never re-bounds on createdAt, resolvedAt,
 * updatedAt or the link's own created_at.
 *
 * STATUS — two statuses are published and both are projected verbatim as separate columns.
 * `findingStatus` is the finding's own persisted status, drawn from the security module's published
 * finding status vocabulary. `linkStatus` is NOT a persisted link lifecycle column: the owning read
 * emits it as a constant `'ACTIVE'` SQL literal, and it is copied exactly as published. Neither
 * column is derived, merged, prioritized or relabeled, and no open, closed, resolved, overdue,
 * aging, breached or escalated value is inferred from `reportedAt`, from the other status, or from
 * anything else. Reporting declares no finding severity or status vocabulary of its own.
 *
 * ACTOR SEMANTICS — the authoritative public row publishes NO actor field of any kind. There is no
 * createdBy, reportedBy, assignedTo, verifiedBy or resolvedBy column, so none is projected and none
 * is inferred, and nothing is relabeled as an executor, performedBy or completedBy. `reportedAt` is
 * an instant, not an actor, and no identity is inferred from any related record.
 *
 * NO SLA, OVERDUE OR AGE ARITHMETIC — no SLA, overdue, age, timeOpen, breach, responseTime or
 * resolutionTime value is computed, no row is classified against a clock, and no current-time
 * arithmetic appears in this path. The envelope asOf belongs to the export metadata and is never
 * compared against `reportedAt`.
 *
 * FILTERS truthfully applied by the owning read are buildingId (scope, on the link's own
 * building_id), status (matched against the FINDING status, `f.status`), securityPostId,
 * patrolRouteId, dateFrom and dateTo. This read matches a security post by direct equality on the
 * link's own start post, which is the same form the SHIFT_HANDOVER source uses and NOT the patrol
 * COALESCE form; that difference is owned by the security domain and is deliberately not reconciled
 * here. No openOnly, unresolvedOnly, criticalOnly, overdue, ageDays, SLA, assignee, latestOnly or
 * currentOnly filter exists, and no generic page, limit, offset, sort or search parameter is
 * accepted. Any other parsed field is ignored by this read exactly as the existing dataset endpoint
 * ignores it.
 *
 * `sourcePostId`, `sourcePostCode`, `sourceRouteId` and `sourceRouteCode` stay nullable because the
 * owning LEFT JOINs can yield no post and no route. Every projected value is a scalar string, so no
 * flattening convention is needed, nothing is JSON-serialized, and the governed renderers accept all
 * eleven columns.
 *
 * Exactly ONE table (`securityOperationalFinding`) is emitted and `kpis` is deliberately empty: no
 * finding count, open count, critical count, closure rate, average age or overdue count is
 * calculated, and the existing Security reporting/KPI authority remains separate and unchanged. No
 * `csvDefaultTableKey` exists for this dataset — its table key is source-dependent, so a
 * dataset-wide CSV default would be wrong; OPERATIONAL_DETAIL remains the only metadata default
 * holder.
 */
export function projectSecurityOperationalFinding(
  source: PublicSecurityFindingDatasetRow[],
): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  return {
    kpis: [],
    tables: [
      table(
        'securityOperationalFinding',
        'Security Operational Finding',
        [
          { key: 'linkId', label: 'Link Id', type: STRING },
          { key: 'findingId', label: 'Finding Id', type: STRING },
          { key: 'findingNumber', label: 'Finding Number', type: STRING },
          { key: 'findingTitle', label: 'Finding Title', type: STRING },
          { key: 'findingStatus', label: 'Finding Status', type: STRING },
          { key: 'linkStatus', label: 'Link Status', type: STRING },
          { key: 'sourcePostId', label: 'Source Post Id', type: STRING },
          { key: 'sourcePostCode', label: 'Source Post Code', type: STRING },
          { key: 'sourceRouteId', label: 'Source Route Id', type: STRING },
          { key: 'sourceRouteCode', label: 'Source Route Code', type: STRING },
          { key: 'reportedAt', label: 'Reported At', type: DATE },
        ],
        source.map((row) => ({
          // The authoritative row identity, copied verbatim: never synthesized and never merged
          // with findingId into a composite key.
          linkId: row.linkId,
          // A related fact that may legitimately repeat across link rows. Never collapsed,
          // deduplicated or elected as "the" finding.
          findingId: row.findingId,
          findingNumber: row.findingNumber,
          findingTitle: row.findingTitle,
          // The finding's own persisted status. Never reinterpreted as an SLA, ageing or
          // escalation outcome, and never merged with linkStatus.
          findingStatus: row.findingStatus,
          // Published by the owning read as a constant 'ACTIVE' literal rather than read from a
          // link lifecycle column. Copied exactly as published and never derived from anything.
          linkStatus: row.linkStatus,
          sourcePostId: row.sourcePostId,
          sourcePostCode: row.sourcePostCode,
          sourceRouteId: row.sourceRouteId,
          sourceRouteCode: row.sourceRouteCode,
          // The persisted reported instant that also owns the period bound. Never compared against
          // asOf and never turned into an age, overdue flag or SLA figure.
          reportedAt: row.reportedAt,
        })),
      ),
    ],
  };
}

/**
 * R10 PART 18 — SECURITY_OPERATIONAL_DETAIL / INCIDENT_READINESS.
 *
 * A PURE re-presentation of the existing governed BE-12M incident-readiness dataset read
 * (`securityReportService.getIncidentReadinessDataset`). No readiness SQL is reproduced here,
 * `security_incident_readiness` is never queried from Reporting, and no second incident-readiness
 * authority, repository, status vocabulary or readiness model is created.
 *
 * GRAIN — ONE Reporting row per ONE existing governed incident-readiness dataset row. The owning
 * read selects from `security_incident_readiness sir` and publishes `sir.id AS binding_id`, so the
 * authoritative row identity is that record's own id, projected verbatim as `bindingId`. No
 * synthetic identity is minted: there is no incidentReadinessKey, compositeIncidentId,
 * currentIncident, latestIncident or primaryIncident, because the authoritative public row has no
 * such field.
 *
 * `securityPostId`, `teamId` and `primaryWorkforceId` are related facts, not row identity. Each is
 * nullable and each may legitimately repeat across several readiness records, so repeated values
 * are PRESERVED as several rows — never collapsed, deduplicated or grouped. There is no DISTINCT,
 * GROUP BY, DISTINCT ON, ROW_NUMBER, LATERAL, LIMIT 1, MAX(timestamp) or sort-and-first anywhere in
 * this path, and no latest, current, most-recent, active, effective or primary record is elected.
 * The three LEFT JOINs resolve `security_posts`, `teams` and `workforce_profiles` by primary key, so
 * they add labels without fanning the grain out.
 *
 * NO PERIOD AUTHORITY — this is the one SECURITY_OPERATIONAL_DETAIL source whose owning read applies
 * NO date bound at all. The service resolves only a Building scope and calls the repository without
 * a start or end, and the SQL carries no date predicate. `dateFrom` and `dateTo` are therefore
 * accepted by the shared parser but IGNORED by this read, and the rows are not period-filtered.
 * Reporting does not invent a period: `updatedAt` is the record's persisted last-update instant and
 * is never used as a bound, and no createdAt, reportedAt, resolvedAt or shift instant is
 * substituted. The owning read's own ordering (`sir.updated_at DESC, sir.created_at DESC`) is
 * preserved as returned, with no post-query sort.
 *
 * STATUS AND READINESS — `status` is the record's own persisted readiness status, drawn from the
 * security module's published incident-readiness status vocabulary, and is copied verbatim. The
 * column key stays `status` exactly as the authoritative row names it; the label names what the
 * source column actually is (the readiness status) rather than implying a different concept.
 * Readiness is never inferred, recomputed or escalated here: no ready, notReady, partial,
 * compliant, overdue, breached or aging value is derived from `updatedAt`, from `category`, or from
 * the responsible team or workforce. `category` is likewise a persisted source value copied as-is,
 * and Reporting declares no readiness or category vocabulary of its own.
 *
 * ACTOR SEMANTICS — the source publishes RESPONSIBILITY, not execution. `teamId` and `teamName`
 * come from the record's `responsible_team_id` and that team's name; `primaryWorkforceId` and
 * `primaryWorkforceName` come from its `responsible_workforce_id` and that workforce profile's full
 * name. They are copied verbatim under the authoritative field names and are never relabeled as an
 * executor, performedBy, completedBy, assignee, responder or actor, because being responsible for a
 * readiness record is not evidence of having performed anything. No actor is inferred for records
 * that have none, no identity is inferred from any related record, and `updatedAt` is an instant
 * rather than an actor.
 *
 * NO SLA, OVERDUE OR AGE ARITHMETIC — no SLA, overdue, age, timeOpen, breach, responseTime,
 * resolutionTime or readiness-percentage value is computed, no row is classified against a clock,
 * and no current-time arithmetic appears in this path. The envelope asOf belongs to the export
 * metadata and is never compared against `updatedAt`.
 *
 * FILTERS truthfully applied by the owning read are buildingId (scope, on the record's own
 * building_id), securityPostId, teamId (matched against the RESPONSIBLE team), workforceId (matched
 * against the RESPONSIBLE workforce), status (the readiness status) and category. Unlike the other
 * three sources this read does NOT apply patrolRouteId, and it applies no date bound; those parsed
 * fields are ignored here exactly as the existing dataset endpoint ignores them. No openOnly,
 * unresolvedOnly, criticalOnly, readyOnly, notReadyOnly, overdue, ageDays, SLA, latestOnly or
 * currentOnly filter exists, and no generic page, limit, offset, sort or search parameter is
 * accepted.
 *
 * `buildingId` IS a column on this row, but the export's building scope is still reported from the
 * authorized filter rather than derived from the returned rows: with buildingId required the two are
 * identical, and taking the scope from the authorization keeps the invariant that Reporting never
 * widens or re-derives an access decision.
 *
 * `securityPostId`, `securityPostCode`, `teamId`, `teamName`, `primaryWorkforceId` and
 * `primaryWorkforceName` stay nullable because the owning LEFT JOINs can yield no post, no team and
 * no workforce profile. Every projected value is a scalar string, so no flattening convention is
 * needed, nothing is JSON-serialized, and the governed renderers accept all eleven columns.
 *
 * Exactly ONE table (`securityOperationalIncidentReadiness`) is emitted and `kpis` is deliberately
 * empty: no readiness percentage, incident count, open count, not-ready count, response KPI, overdue
 * KPI or SLA KPI is calculated, and the existing Security reporting/KPI authority remains separate
 * and unchanged. No `csvDefaultTableKey` exists for this dataset — its table key is
 * source-dependent, so a dataset-wide CSV default would be wrong; OPERATIONAL_DETAIL remains the
 * only metadata default holder.
 */
export function projectSecurityOperationalIncidentReadiness(
  source: PublicIncidentReadinessDatasetRow[],
): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  return {
    kpis: [],
    tables: [
      table(
        'securityOperationalIncidentReadiness',
        'Security Operational Incident Readiness',
        [
          { key: 'bindingId', label: 'Binding Id', type: STRING },
          { key: 'buildingId', label: 'Building Id', type: STRING },
          { key: 'securityPostId', label: 'Security Post Id', type: STRING },
          { key: 'securityPostCode', label: 'Security Post Code', type: STRING },
          { key: 'category', label: 'Category', type: STRING },
          // The record's own persisted readiness status. The key stays `status` exactly as the
          // authoritative row names it; the label names the source concept.
          { key: 'status', label: 'Readiness Status', type: STRING },
          // RESPONSIBLE team, not an executing or completing actor.
          { key: 'teamId', label: 'Team Id', type: STRING },
          { key: 'teamName', label: 'Team Name', type: STRING },
          // RESPONSIBLE primary workforce, not an executing or completing actor.
          { key: 'primaryWorkforceId', label: 'Primary Workforce Id', type: STRING },
          { key: 'primaryWorkforceName', label: 'Primary Workforce Name', type: STRING },
          { key: 'updatedAt', label: 'Updated At', type: DATE },
        ],
        source.map((row) => ({
          // The authoritative row identity, copied verbatim: never synthesized and never merged
          // with any related fact into a composite key.
          bindingId: row.bindingId,
          buildingId: row.buildingId,
          securityPostId: row.securityPostId,
          securityPostCode: row.securityPostCode,
          // A persisted source value, copied as-is. No readiness or category vocabulary is
          // declared or interpreted in Reporting.
          category: row.category,
          // The persisted readiness status. Never derived from updatedAt or from anything else,
          // and never recomputed as a percentage, an SLA or an overdue flag.
          status: row.status,
          // Responsibility as persisted by the source. Never relabeled as an executor, a
          // performer, a completer or an assignee, and never inferred where the source has none.
          teamId: row.teamId,
          teamName: row.teamName,
          primaryWorkforceId: row.primaryWorkforceId,
          primaryWorkforceName: row.primaryWorkforceName,
          // The persisted last-update instant that also owns the source's row ordering. Not a
          // period bound, never compared against asOf, and never turned into an age or SLA.
          updatedAt: row.updatedAt,
        })),
      ),
    ],
  };
}

/**
 * R10 PART 19 — INCIDENT_REGISTER.
 *
 * A PURE re-presentation of the existing governed BE-21A incident list read
 * (`listIncidents`). BE-21A is the ONE shared Incident foundation, distinguished only by its own
 * `incidentType` discriminator, and it already serves Operational Incident (BE-21B), Asset Failure
 * / Defect (BE-21C) and Finding Escalation (BE-21D). Reporting adds nothing to it: no incident
 * lifecycle, no incident repository, no incident status authority, no KPI authority, no universal
 * incident model and no duplicate Incident model is created here, and no incident table is queried
 * from Reporting.
 *
 * This is NOT the BE-21B operational-incident composite view, which layers a lifecycle transition
 * gate and permission-derived `availableActions` on top of the same foundation records; those are
 * UI affordances, not register facts. It is also NOT the incident-closure read (a closure-status
 * view over the same records) and NOT the security finding/incident KPI authority, which stays
 * separate and unchanged.
 *
 * GRAIN — ONE Reporting row per ONE authoritative public incident row, i.e. per one foundation
 * record. The owning list returns its driver rows directly through a single shared column-alias
 * list with no join fan-out and no child expansion, and the cancellation and closure facts are
 * columns ON the record rather than child rows, so nothing is expanded, collapsed or merged here.
 * All three incident kinds appear in this one register exactly as the foundation holds them:
 * Reporting does not split the register by `incidentType`, adds no per-type table, and never
 * relabels a type.
 *
 * IDENTITY — `id`, the foundation record's own primary key, copied verbatim. `incidentNumber` is
 * the Client-unique business number and is preserved as an ordinary fact: it is never used as the
 * row identity and never combined with anything into a composite key. No incidentKey,
 * incidentCompositeId, latestIncidentId or currentIncidentId is minted, because the authoritative
 * public row has no such field.
 *
 * NO PERIOD AUTHORITY — the owning filter contract has no date window and the generated SQL carries
 * no date predicate, so this register is not period-bounded. The five published instants
 * (`reportedAt`, `cancelledAt`, `closedAt`, `createdAt`, `updatedAt`) are persisted facts, never
 * bounds, and none is substituted for another. The owning read's own ordering
 * (`reported_at DESC, id DESC`) is preserved exactly as returned, with no post-query sort.
 *
 * STATUS — the record's own persisted status from the foundation's published vocabulary
 * (REPORTED, CANCELLED, CLOSED), copied verbatim. Closure is NEVER inferred: `closedAt`,
 * `closedByUserId` and `closureNotes` are separate persisted facts, so a record carrying a
 * `closedAt` while its status says otherwise is copied exactly as the source published it. No
 * closure, readiness, overdue, SLA, age or staleness value is derived from any timestamp, and no
 * status is recomputed from `severity`, `priority` or `incidentType`.
 *
 * ACTORS — the source publishes persisted actor REFERENCES and nothing else: `reportedByUserId`
 * (who reported it), `cancelledByUserId` (who cancelled it) and `closedByUserId` (who closed it).
 * They keep those exact meanings and are never relabeled as an executor, completer, assignee,
 * owner, reviewer or responder, and no actor is inferred for a record that has none. Reporting
 * resolves no user, team or workforce NAME for them, because the owning read publishes no name and
 * enriching from an unrelated module would invent a fact the source does not own.
 *
 * `locationId` is the owning module's OWN published derivation — the single BE-04 reference implied
 * by `locationType` — and is copied verbatim; Reporting never re-derives it. All five location
 * references (`floorId`, `areaId`, `roomId`, `spaceId`, `functionalLocationId`) stay published side
 * by side with `locationType`, so no location is collapsed and no hierarchy is inferred. `clientId`
 * is likewise the source's own derived tenancy fact (Building -> Property -> Client), copied
 * verbatim: Reporting never accepts a caller-supplied clientId and never re-derives tenancy.
 *
 * SCOPE — `buildingId` is an OPTIONAL narrowing filter, exactly as the owning read supports it: the
 * service asserts Building access when it is present and always scopes the query in SQL to the
 * actor's accessible Buildings, returning zero rows without querying when that scope is empty. A
 * multi-Building rollup is therefore the source's own behaviour and is not narrowed or widened
 * here. Client and Building isolation stays entirely with the owning service.
 *
 * FILTERS — only the five the owning parser owns (`buildingId`, `incidentType`, `severity`,
 * `priority`, `status`), validated against the foundation's own published vocabularies. No
 * criticalOnly, openOnly, unresolvedOnly, overdue, ageDays, SLA, latestOnly or currentOnly filter
 * exists, and no generic page, limit, offset, sort or search parameter is accepted.
 *
 * NO SLA, OVERDUE OR AGE ARITHMETIC — no SLA, overdue, age, timeOpen, breach, responseTime,
 * resolutionTime or days-to-close value is computed, no row is classified against a clock, and no
 * current-time arithmetic appears in this path. The envelope asOf belongs to the export metadata
 * and is never compared against any incident instant.
 *
 * All 26 published fields are renderer-safe scalars (string or string | null), in the authoritative
 * order the owning read produces them — `locationId` last, because the owning mapper appends it to
 * the record — so no flattening convention is needed and nothing is JSON-serialized. Exactly ONE
 * table (`incidentRegister`) is emitted, with no secondary child table, and `kpis` is deliberately
 * empty: no incident count, open count, critical count, closure rate, average age or SLA KPI is
 * calculated. No `csvDefaultTableKey` is added; OPERATIONAL_DETAIL remains the only dataset with a
 * metadata default.
 */
export function projectIncidentRegister(source: PublicIncident[]): {
  kpis: ReportingExportKpiValue[];
  tables: ReportingExportTable[];
} {
  return {
    kpis: [],
    tables: [
      table(
        'incidentRegister',
        'Incident Register',
        [
          { key: 'id', label: 'Incident Id', type: STRING },
          // The source's own derived tenancy fact, never accepted from the caller.
          { key: 'clientId', label: 'Client Id', type: STRING },
          { key: 'buildingId', label: 'Building Id', type: STRING },
          // The Client-unique business number: an ordinary fact, never the row identity.
          { key: 'incidentNumber', label: 'Incident No', type: STRING },
          // The foundation's own discriminator; all three kinds share this one register.
          { key: 'incidentType', label: 'Incident Type', type: STRING },
          { key: 'title', label: 'Title', type: STRING },
          { key: 'description', label: 'Description', type: STRING },
          { key: 'severity', label: 'Severity', type: STRING },
          { key: 'priority', label: 'Priority', type: STRING },
          // The persisted foundation status. Never inferred from any timestamp.
          { key: 'status', label: 'Status', type: STRING },
          { key: 'locationType', label: 'Location Type', type: STRING },
          // All five BE-04 references stay side by side: no collapse, no hierarchy inference.
          { key: 'floorId', label: 'Floor Id', type: STRING },
          { key: 'areaId', label: 'Area Id', type: STRING },
          { key: 'roomId', label: 'Room Id', type: STRING },
          { key: 'spaceId', label: 'Space Id', type: STRING },
          { key: 'functionalLocationId', label: 'Functional Location Id', type: STRING },
          // Persisted actor reference: who REPORTED. Never relabeled as an executor or owner.
          { key: 'reportedByUserId', label: 'Reported By User Id', type: STRING },
          { key: 'reportedAt', label: 'Reported At', type: DATE },
          { key: 'cancelledAt', label: 'Cancelled At', type: DATE },
          // Persisted actor reference: who CANCELLED.
          { key: 'cancelledByUserId', label: 'Cancelled By User Id', type: STRING },
          { key: 'closedAt', label: 'Closed At', type: DATE },
          // Persisted actor reference: who CLOSED. Closure is never inferred from closedAt.
          { key: 'closedByUserId', label: 'Closed By User Id', type: STRING },
          { key: 'closureNotes', label: 'Closure Notes', type: STRING },
          { key: 'createdAt', label: 'Created At', type: DATE },
          { key: 'updatedAt', label: 'Updated At', type: DATE },
          // The owning module's own derivation of the single BE-04 reference implied by
          // locationType, published LAST by its mapper and copied verbatim, never re-derived.
          { key: 'locationId', label: 'Location Id', type: STRING },
        ],
        source.map((row) => ({
          // The authoritative row identity, copied verbatim: never synthesized and never merged
          // with incidentNumber or clientId into a composite key.
          id: row.id,
          clientId: row.clientId,
          buildingId: row.buildingId,
          incidentNumber: row.incidentNumber,
          incidentType: row.incidentType,
          title: row.title,
          description: row.description,
          severity: row.severity,
          priority: row.priority,
          // The persisted status. Never recomputed from severity, priority or any timestamp.
          status: row.status,
          locationType: row.locationType,
          floorId: row.floorId,
          areaId: row.areaId,
          roomId: row.roomId,
          spaceId: row.spaceId,
          functionalLocationId: row.functionalLocationId,
          // Persisted actor references with their exact source meanings. No name is resolved and
          // no executor, completer, assignee, owner or reviewer is inferred.
          reportedByUserId: row.reportedByUserId,
          // Persisted instants. None is a period bound and none is compared against asOf.
          reportedAt: row.reportedAt,
          cancelledAt: row.cancelledAt,
          cancelledByUserId: row.cancelledByUserId,
          closedAt: row.closedAt,
          closedByUserId: row.closedByUserId,
          closureNotes: row.closureNotes,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          // The source's own published location derivation, copied as-is.
          locationId: row.locationId,
        })),
      ),
    ],
  };
}
