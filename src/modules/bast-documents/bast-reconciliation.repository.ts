import { getPool } from '../../database';
import type {
  BastReconciliationItem,
  BastReconciliationSeverity,
} from './bast-reconciliation.types';

type InventoryRow = Record<string, unknown>;

function value(row: InventoryRow, key: string): string | null {
  const result = row[key];
  return typeof result === 'string' ? result : null;
}

function flag(row: InventoryRow, key: string): boolean {
  return row[key] === true;
}

function add(
  items: BastReconciliationItem[],
  keys: Set<string>,
  item: BastReconciliationItem,
): void {
  const key = [
    item.classification,
    item.canonicalBastDocumentId,
    item.legacyVendorBastBindingId,
    item.message,
  ].join(':');
  if (keys.has(key)) return;
  keys.add(key);
  items.push(item);
}

function canonicalItem(
  row: InventoryRow,
  classification: BastReconciliationItem['classification'],
  severity: BastReconciliationSeverity,
  message: string,
): BastReconciliationItem {
  return {
    classification,
    severity,
    canonicalBastDocumentId: value(row, 'canonicalId'),
    legacyVendorBastBindingId: value(row, 'legacyId'),
    bastNumber: value(row, 'bastNumber'),
    message,
  };
}

function legacyItem(
  row: InventoryRow,
  classification: BastReconciliationItem['classification'],
  severity: BastReconciliationSeverity,
  message: string,
): BastReconciliationItem {
  return {
    classification,
    severity,
    canonicalBastDocumentId: value(row, 'canonicalId'),
    legacyVendorBastBindingId: value(row, 'legacyId'),
    bastNumber: value(row, 'bastNumber'),
    message,
  };
}

/**
 * Produces a source inventory only. Every query is SELECT-only and constrained
 * to one Building before counterpart identifiers are projected.
 */
export async function inventoryBuilding(
  buildingId: string,
): Promise<BastReconciliationItem[]> {
  const [canonicalResult, legacyResult] = await Promise.all([
    getPool().query<InventoryRow>(
      `SELECT
         bd.id AS "canonicalId",
         visible_legacy.id AS "legacyId",
         bd.bast_number AS "bastNumber",
         bd.acceptance_status AS "canonicalStatus",
         visible_legacy.acceptance_status AS "legacyStatus",
         visible_legacy.bast_number AS "legacyBastNumber",
         visible_legacy.client_id AS "legacyClientId",
         visible_legacy.building_id AS "legacyBuildingId",
         visible_legacy.work_order_id AS "legacyWorkOrderId",
         visible_legacy.vendor_work_id AS "legacyVendorWorkId",
         bd.client_id AS "canonicalClientId",
         bd.building_id AS "canonicalBuildingId",
         bd.work_order_id AS "canonicalWorkOrderId",
         bd.vendor_work_id AS "canonicalVendorWorkId",
         bd.vendor_id AS "canonicalVendorId",
         bd.completion_report_id AS "canonicalCompletionReportId",
         bd.service_report_id AS "canonicalServiceReportId",
         bd.acceptance_scope_type AS "acceptanceScopeType",
         d.id AS "documentExists",
         d.client_id AS "documentClientId",
         d.building_id AS "documentBuildingId",
         d.source_id AS "documentSourceId",
         wo.id AS "workOrderExists",
         wo.client_id AS "workOrderClientId",
         wo.building_id AS "workOrderBuildingId",
         wo.status AS "workOrderStatus",
         wo.bast_requirement AS "bastRequirement",
         vw.id AS "vendorWorkExists",
         vw.work_order_id AS "vendorWorkOrderId",
         vw.building_id AS "vendorWorkBuildingId",
         vw.vendor_id AS "expectedVendorId",
         cr.id AS "expectedCompletionReportId",
         sr.id AS "expectedServiceReportId",
         EXISTS (
           SELECT 1 FROM vendor_bast_bindings hidden
           WHERE hidden.bast_document_id = bd.id
             AND hidden.building_id <> $1
         ) AS "hasHiddenLegacyLink",
         EXISTS (
           SELECT 1 FROM vendor_bast_bindings numbered
           WHERE numbered.building_id = $1
             AND numbered.bast_number = bd.bast_number
             AND numbered.client_id = bd.client_id
             AND numbered.bast_document_id IS DISTINCT FROM bd.id
         ) AS "hasDuplicateNumber",
         EXISTS (
           SELECT 1 FROM vendor_bast_bindings scoped
           WHERE scoped.building_id = $1
             AND scoped.vendor_work_id = bd.vendor_work_id
             AND scoped.bast_document_id IS DISTINCT FROM bd.id
         ) AS "hasDuplicateVendorScope",
         (
           SELECT COUNT(*) > 1
           FROM vendor_bast_bindings duplicate_link
           WHERE duplicate_link.building_id = $1
             AND duplicate_link.bast_document_id = bd.id
         ) AS "hasDuplicateLegacyLink",
         EXISTS (
           SELECT 1 FROM bast_documents scoped
           WHERE scoped.id <> bd.id
             AND scoped.building_id = $1
             AND scoped.work_order_id = bd.work_order_id
             AND scoped.acceptance_scope_type = 'WORK_ORDER'
             AND bd.acceptance_scope_type = 'WORK_ORDER'
         ) AS "hasDuplicateWorkOrderScope",
         EXISTS (
           SELECT 1 FROM acceptance_sign_offs aso
           WHERE aso.bast_document_id = bd.id AND aso.decision = 'ACCEPTED'
         ) AS "hasAcceptedSignOff",
         EXISTS (
           SELECT 1 FROM acceptance_sign_offs aso
           WHERE aso.bast_document_id = bd.id AND aso.decision = 'REJECTED'
         ) AS "hasRejectedSignOff",
         EXISTS (
           SELECT 1 FROM acceptance_sign_offs aso
           WHERE aso.bast_document_id = bd.id
             AND (aso.bast_submission_attempt_id IS NULL OR aso.document_version_id IS NULL)
         ) AS "hasUnpinnedSignOff",
         EXISTS (
           SELECT 1 FROM bast_submission_attempts attempt
           WHERE attempt.bast_document_id = bd.id
         ) AS "hasSubmissionAttempt"
       FROM bast_documents bd
       LEFT JOIN documents d ON d.id = bd.document_id
       LEFT JOIN work_orders wo ON wo.id = bd.work_order_id
       LEFT JOIN vendor_works vw ON vw.id = bd.vendor_work_id
       LEFT JOIN vendor_completion_reports cr ON cr.vendor_work_id = bd.vendor_work_id
       LEFT JOIN vendor_service_reports sr ON sr.vendor_work_id = bd.vendor_work_id
       LEFT JOIN vendor_bast_bindings visible_legacy
         ON visible_legacy.bast_document_id = bd.id
        AND visible_legacy.building_id = $1
       WHERE bd.building_id = $1
       ORDER BY bd.created_at, bd.id`,
      [buildingId],
    ),
    getPool().query<InventoryRow>(
       `SELECT
         visible_canonical.id AS "canonicalId",
         vbb.bast_document_id AS "rawCanonicalId",
         vbb.id AS "legacyId",
         vbb.bast_number AS "bastNumber",
         vbb.acceptance_status AS "legacyStatus",
         vbb.client_id AS "legacyClientId",
         vbb.building_id AS "legacyBuildingId",
         vbb.work_order_id AS "legacyWorkOrderId",
         vbb.vendor_work_id AS "legacyVendorWorkId",
         vbb.completion_report_id AS "legacyCompletionReportId",
         vbb.service_report_id AS "legacyServiceReportId",
         visible_canonical.acceptance_status AS "canonicalStatus",
         visible_canonical.bast_number AS "canonicalBastNumber",
         EXISTS (
           SELECT 1 FROM bast_submission_attempts attempt
           WHERE attempt.bast_document_id = visible_canonical.id
         ) AS "hasSubmissionAttempt",
         wo.id AS "workOrderExists",
         wo.client_id AS "workOrderClientId",
         wo.building_id AS "workOrderBuildingId",
         wo.status AS "workOrderStatus",
         vw.id AS "vendorWorkExists",
         vw.work_order_id AS "vendorWorkOrderId",
         vw.building_id AS "vendorWorkBuildingId",
         cr.id AS "expectedCompletionReportId",
         sr.id AS "expectedServiceReportId",
         (vbb.bast_document_id IS NOT NULL AND visible_canonical.id IS NULL) AS "hasHiddenCanonicalLink",
         EXISTS (
           SELECT 1 FROM bast_documents scoped
           WHERE scoped.building_id = $1
             AND scoped.vendor_work_id = vbb.vendor_work_id
             AND scoped.id IS DISTINCT FROM vbb.bast_document_id
         ) AS "hasDuplicateVendorScope",
         EXISTS (
           SELECT 1 FROM vendor_bast_bindings duplicate_link
           WHERE duplicate_link.id <> vbb.id
             AND duplicate_link.building_id = $1
             AND duplicate_link.bast_document_id = vbb.bast_document_id
             AND vbb.bast_document_id IS NOT NULL
         ) AS "hasDuplicateLegacyLink",
         EXISTS (
           SELECT 1 FROM bast_documents numbered
           WHERE numbered.building_id = $1
             AND numbered.client_id = vbb.client_id
             AND numbered.bast_number = vbb.bast_number
             AND numbered.id IS DISTINCT FROM vbb.bast_document_id
         ) AS "hasDuplicateNumber"
       FROM vendor_bast_bindings vbb
       LEFT JOIN bast_documents visible_canonical
         ON visible_canonical.id = vbb.bast_document_id
        AND visible_canonical.building_id = $1
       LEFT JOIN work_orders wo ON wo.id = vbb.work_order_id
       LEFT JOIN vendor_works vw ON vw.id = vbb.vendor_work_id
       LEFT JOIN vendor_completion_reports cr ON cr.vendor_work_id = vbb.vendor_work_id
       LEFT JOIN vendor_service_reports sr ON sr.vendor_work_id = vbb.vendor_work_id
       WHERE vbb.building_id = $1
       ORDER BY vbb.created_at, vbb.id`,
      [buildingId],
    ),
  ]);

  const items: BastReconciliationItem[] = [];
  const keys = new Set<string>();

  for (const row of canonicalResult.rows) {
    const canonicalId = value(row, 'canonicalId');
    const legacyId = value(row, 'legacyId');
    const canonicalStatus = value(row, 'canonicalStatus');
    const legacyStatus = value(row, 'legacyStatus');
    const vendorWorkId = value(row, 'canonicalVendorWorkId');
    const scope = value(row, 'acceptanceScopeType');

    if (legacyId) {
      const contextMatches =
        value(row, 'canonicalClientId') === value(row, 'legacyClientId') &&
        value(row, 'canonicalBuildingId') === value(row, 'legacyBuildingId') &&
        value(row, 'canonicalWorkOrderId') === value(row, 'legacyWorkOrderId') &&
        value(row, 'canonicalVendorWorkId') === value(row, 'legacyVendorWorkId');
      if (
        contextMatches &&
        canonicalStatus === legacyStatus &&
        value(row, 'bastNumber') === value(row, 'legacyBastNumber')
      ) {
        add(items, keys, canonicalItem(row, 'LINKED_CONSISTENT', 'INFO', 'Canonical BAST and legacy compatibility projection are linked consistently.'));
      }
      if (!contextMatches) {
        add(items, keys, canonicalItem(row, 'DIVERGENT_CONTEXT', 'ERROR', 'Canonical and linked legacy work context differs.'));
      }
      if (canonicalStatus !== legacyStatus) {
        add(items, keys, canonicalItem(row, 'DIVERGENT_LIFECYCLE', 'ERROR', 'Canonical and linked legacy acceptance lifecycle states differ.'));
      }
    } else {
      add(items, keys, canonicalItem(row, 'CANONICAL_ONLY', 'INFO', 'Canonical BAST has no visible linked legacy compatibility projection.'));
    }

    if (flag(row, 'hasHiddenLegacyLink')) {
      add(items, keys, { ...canonicalItem(row, 'CROSS_SCOPE_SECURITY_MISMATCH', 'ERROR', 'A linked legacy projection resolves outside the requested Building.'), legacyVendorBastBindingId: null });
    }
    if (!value(row, 'documentExists') || !value(row, 'workOrderExists')) {
      add(items, keys, canonicalItem(row, 'ORPHAN', 'ERROR', 'Canonical BAST has an unresolved core Document or Work Order reference.'));
    }
    if (
      value(row, 'canonicalClientId') !== value(row, 'workOrderClientId') ||
      value(row, 'canonicalBuildingId') !== value(row, 'workOrderBuildingId') ||
      value(row, 'canonicalClientId') !== value(row, 'documentClientId') ||
      value(row, 'canonicalBuildingId') !== value(row, 'documentBuildingId')
    ) {
      add(items, keys, canonicalItem(row, 'DIVERGENT_CONTEXT', 'ERROR', 'Canonical Client/Building context differs from its Work Order or shared Document.'));
    }
    if (
      vendorWorkId &&
      (value(row, 'vendorWorkOrderId') !== value(row, 'canonicalWorkOrderId') ||
        value(row, 'vendorWorkBuildingId') !== value(row, 'canonicalBuildingId'))
    ) {
      add(items, keys, canonicalItem(row, 'AMBIGUOUS_WORK_RELATIONSHIP', 'ERROR', 'Canonical Vendor Work does not resolve to the canonical Work Order and Building.'));
    }
    if ((scope === 'VENDOR_WORK' && !vendorWorkId) || (scope === 'WORK_ORDER' && vendorWorkId)) {
      add(items, keys, canonicalItem(row, 'AMBIGUOUS_WORK_RELATIONSHIP', 'ERROR', 'Acceptance scope conflicts with the canonical Work Order/Vendor Work relationship.'));
    }
    if (!scope || (vendorWorkId && !value(row, 'canonicalVendorId'))) {
      add(items, keys, canonicalItem(row, 'MISSING_REFERENCE', 'WARNING', 'Canonical acceptance scope or applicable Vendor reference is not pinned.'));
    }
    if (
      vendorWorkId &&
      value(row, 'canonicalVendorId') &&
      value(row, 'canonicalVendorId') !== value(row, 'expectedVendorId')
    ) {
      add(items, keys, canonicalItem(row, 'DIVERGENT_CONTEXT', 'ERROR', 'Pinned Vendor differs from the Vendor Work authority.'));
    }
    if (
      value(row, 'expectedCompletionReportId') &&
      !value(row, 'canonicalCompletionReportId')
    ) {
      add(items, keys, canonicalItem(row, 'MISSING_REFERENCE', 'WARNING', 'Applicable Completion Report is not pinned on the canonical BAST.'));
    } else if (
      value(row, 'canonicalCompletionReportId') &&
      value(row, 'canonicalCompletionReportId') !== value(row, 'expectedCompletionReportId')
    ) {
      add(items, keys, canonicalItem(row, 'DIVERGENT_CONTEXT', 'ERROR', 'Pinned Completion Report differs from the Vendor Work authority.'));
    }
    if (value(row, 'expectedServiceReportId') && !value(row, 'canonicalServiceReportId')) {
      add(items, keys, canonicalItem(row, 'MISSING_REFERENCE', 'WARNING', 'Applicable Service Report is not pinned on the canonical BAST.'));
    } else if (
      value(row, 'canonicalServiceReportId') &&
      value(row, 'canonicalServiceReportId') !== value(row, 'expectedServiceReportId')
    ) {
      add(items, keys, canonicalItem(row, 'DIVERGENT_CONTEXT', 'ERROR', 'Pinned Service Report differs from the Vendor Work authority.'));
    }
    if (flag(row, 'hasDuplicateNumber')) {
      add(items, keys, canonicalItem(row, 'DUPLICATE_NUMBER', 'ERROR', 'BAST business number is also used by an unlinked legacy record.'));
    }
    if (
      flag(row, 'hasDuplicateVendorScope') ||
      flag(row, 'hasDuplicateWorkOrderScope') ||
      flag(row, 'hasDuplicateLegacyLink')
    ) {
      add(items, keys, canonicalItem(row, 'DUPLICATE_ACCEPTANCE_SCOPE', 'ERROR', 'More than one canonical or legacy record claims the same acceptance scope.'));
    }
    const acceptedSignOff = flag(row, 'hasAcceptedSignOff');
    const rejectedSignOff = flag(row, 'hasRejectedSignOff');
    if (
      (acceptedSignOff && rejectedSignOff) ||
      (acceptedSignOff && canonicalStatus !== 'ACCEPTED') ||
      (rejectedSignOff && canonicalStatus !== 'REJECTED')
    ) {
      add(items, keys, canonicalItem(row, 'CONTRADICTORY_SIGN_OFF', 'ERROR', 'Acceptance sign-off history contradicts the canonical lifecycle state.'));
    }
    if (
      (canonicalStatus !== 'DRAFT' && !flag(row, 'hasSubmissionAttempt')) ||
      flag(row, 'hasUnpinnedSignOff')
    ) {
      add(items, keys, canonicalItem(row, 'MISSING_VERSION', 'WARNING', 'Submitted or decided BAST history is not pinned to an immutable submission Document Version.'));
    }
    if (value(row, 'workOrderStatus') === 'CLOSED' && canonicalStatus !== 'ACCEPTED') {
      add(items, keys, canonicalItem(row, 'CLOSED_BEFORE_ACCEPTED', 'WARNING', 'Work Order is closed while canonical BAST is not accepted.'));
    }
    if (!canonicalId) {
      add(items, keys, canonicalItem(row, 'ORPHAN', 'ERROR', 'Canonical inventory row has no canonical identity.'));
    }
  }

  for (const row of legacyResult.rows) {
    const canonicalId = value(row, 'canonicalId');
    const legacyStatus = value(row, 'legacyStatus');
    if (!canonicalId) {
      add(items, keys, legacyItem(row, 'LEGACY_ONLY', 'WARNING', 'Legacy compatibility record has no visible canonical BAST link.'));
    }
    if (!canonicalId && !value(row, 'rawCanonicalId')) {
      add(items, keys, legacyItem(row, 'MISSING_REFERENCE', 'WARNING', 'Legacy compatibility record has no canonical BAST reference.'));
    }
    if (flag(row, 'hasHiddenCanonicalLink')) {
      add(items, keys, { ...legacyItem(row, 'CROSS_SCOPE_SECURITY_MISMATCH', 'ERROR', 'The canonical BAST link resolves outside the requested Building.'), canonicalBastDocumentId: null });
    }
    if (!value(row, 'workOrderExists') || !value(row, 'vendorWorkExists')) {
      add(items, keys, legacyItem(row, 'ORPHAN', 'ERROR', 'Legacy compatibility record has an unresolved Work Order or Vendor Work reference.'));
    }
    if (
      value(row, 'legacyClientId') !== value(row, 'workOrderClientId') ||
      value(row, 'legacyBuildingId') !== value(row, 'workOrderBuildingId')
    ) {
      add(items, keys, legacyItem(row, 'DIVERGENT_CONTEXT', 'ERROR', 'Legacy Client/Building context differs from its Work Order authority.'));
    }
    if (
      value(row, 'legacyWorkOrderId') !== value(row, 'vendorWorkOrderId') ||
      value(row, 'legacyBuildingId') !== value(row, 'vendorWorkBuildingId')
    ) {
      add(items, keys, legacyItem(row, 'AMBIGUOUS_WORK_RELATIONSHIP', 'ERROR', 'Legacy Vendor Work does not resolve to the stored Work Order and Building.'));
    }
    if (
      value(row, 'expectedCompletionReportId') &&
      !value(row, 'legacyCompletionReportId')
    ) {
      add(items, keys, legacyItem(row, 'MISSING_REFERENCE', 'WARNING', 'Applicable Completion Report is absent from the legacy projection.'));
    }
    if (value(row, 'expectedServiceReportId') && !value(row, 'legacyServiceReportId')) {
      add(items, keys, legacyItem(row, 'MISSING_REFERENCE', 'WARNING', 'Applicable Service Report is absent from the legacy projection.'));
    }
    if (flag(row, 'hasDuplicateNumber')) {
      add(items, keys, legacyItem(row, 'DUPLICATE_NUMBER', 'ERROR', 'Legacy BAST business number is also used by an unlinked canonical BAST.'));
    }
    if (
      flag(row, 'hasDuplicateVendorScope') ||
      flag(row, 'hasDuplicateLegacyLink')
    ) {
      add(items, keys, legacyItem(row, 'DUPLICATE_ACCEPTANCE_SCOPE', 'ERROR', 'More than one canonical or legacy record claims this acceptance scope.'));
    }
    if (
      canonicalId &&
      (legacyStatus !== value(row, 'canonicalStatus') ||
        value(row, 'bastNumber') !== value(row, 'canonicalBastNumber'))
    ) {
      add(items, keys, legacyItem(row, 'DIVERGENT_LIFECYCLE', 'ERROR', 'Linked compatibility lifecycle or business identity differs from canonical BAST authority.'));
    }
    if (legacyStatus !== 'DRAFT' && !flag(row, 'hasSubmissionAttempt')) {
      add(items, keys, legacyItem(row, 'MISSING_VERSION', 'WARNING', 'Submitted or decided legacy BAST history has no canonical immutable submission Document Version.'));
    }
    if (value(row, 'workOrderStatus') === 'CLOSED' && legacyStatus !== 'ACCEPTED' && !canonicalId) {
      add(items, keys, legacyItem(row, 'CLOSED_BEFORE_ACCEPTED', 'WARNING', 'Work Order is closed while legacy-only BAST is not accepted.'));
    }
  }

  return items;
}

export const bastReconciliationRepository = { inventoryBuilding };
