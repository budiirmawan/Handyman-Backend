import type { WorkOrderRecord } from '../work-orders';
import {
  bastClosureReadinessRepository,
  type BastClosureDocumentRecord,
} from './bast-closure-readiness.repository';
import type {
  BastClosureBlocker,
  WorkOrderBastClosureReadiness,
} from './bast-closure-readiness.types';

function assessRequiredBast(
  records: BastClosureDocumentRecord[],
  vendorWorkId?: string,
): BastClosureBlocker[] {
  const scope = vendorWorkId ? { vendorWorkId } : {};
  if (records.length === 0) {
    return [{ code: 'REQUIRED_BAST_MISSING', ...scope }];
  }
  if (records.length !== 1) {
    return [{ code: 'REQUIRED_BAST_CARDINALITY_VIOLATION', ...scope }];
  }

  const bast = records[0];
  if (bast.hasOpenReconciliationQuarantine) {
    return [{ code: 'RECONCILIATION_QUARANTINED', ...scope }];
  }
  if (bast.acceptanceStatus !== 'ACCEPTED') {
    return [{ code: 'REQUIRED_BAST_NOT_ACCEPTED', ...scope }];
  }
  if (!bast.acceptanceTraceable) {
    return [{ code: 'ACCEPTANCE_NOT_TRACEABLE', ...scope }];
  }
  if (bast.hasUnresolvedFinding) {
    return [{ code: 'UNRESOLVED_BAST_REWORK', ...scope }];
  }
  return [];
}

/**
 * Evaluates the Work Order's configured BAST cardinality from canonical BE-22
 * rows only. Legacy vendor_bast_bindings are deliberately not queried.
 */
export async function evaluateWorkOrderBastClosureReadiness(
  workOrder: Pick<
    WorkOrderRecord,
    'id' | 'clientId' | 'buildingId' | 'bastRequirement'
  >,
): Promise<WorkOrderBastClosureReadiness> {
  if (workOrder.bastRequirement === 'NONE') {
    return { requirement: 'NONE', ready: true, blockers: [] };
  }

  const input = {
    workOrderId: workOrder.id,
    clientId: workOrder.clientId,
    buildingId: workOrder.buildingId,
  };
  const [vendorWorks, bastDocuments] = await Promise.all([
    bastClosureReadinessRepository.listVendorWorks(input),
    bastClosureReadinessRepository.listCanonicalBastDocuments(input),
  ]);
  const blockers: BastClosureBlocker[] = [];

  if (workOrder.bastRequirement === 'WORK_ORDER') {
    const workOrderScope = bastDocuments.filter(
      (bast) =>
        bast.vendorWorkId === null &&
        bast.acceptanceScopeType === 'WORK_ORDER',
    );
    if (workOrderScope.some((bast) => !bast.contextMatches)) {
      blockers.push({ code: 'CANONICAL_CONTEXT_MISMATCH' });
    } else {
      blockers.push(...assessRequiredBast(workOrderScope));
    }
  } else {
    if (vendorWorks.length === 0) {
      blockers.push({ code: 'NO_APPLICABLE_VENDOR_WORK' });
    }

    if (vendorWorks.some((vendorWork) => !vendorWork.contextMatches)) {
      blockers.push({ code: 'CANONICAL_CONTEXT_MISMATCH' });
    }

    for (const vendorWork of vendorWorks) {
      if (!vendorWork.contextMatches) continue;
      if (vendorWork.hasUnresolvedRework) {
        blockers.push({
          code: 'UNRESOLVED_VENDOR_REWORK',
          vendorWorkId: vendorWork.id,
        });
      }
      const vendorScope = bastDocuments.filter(
        (bast) =>
          bast.vendorWorkId === vendorWork.id &&
          bast.acceptanceScopeType === 'VENDOR_WORK',
      );
      if (vendorScope.some((bast) => !bast.contextMatches)) {
        blockers.push({
          code: 'CANONICAL_CONTEXT_MISMATCH',
          vendorWorkId: vendorWork.id,
        });
      } else {
        blockers.push(...assessRequiredBast(vendorScope, vendorWork.id));
      }
    }
  }

  return {
    requirement: workOrder.bastRequirement,
    ready: blockers.length === 0,
    blockers,
  };
}
