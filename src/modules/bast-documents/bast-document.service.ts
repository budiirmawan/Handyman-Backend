import { randomUUID } from 'node:crypto';
import { buildingRepository } from '../buildings';
import { clientRepository } from '../clients';
import { contextAccessService } from '../context-access';
import { resolveBuildingsForUser } from '../building-assignments';
import { propertyRepository } from '../properties';
import { tenantCompanyRepository } from '../tenant-companies';
import { vendorRepository } from '../vendors';
import { workOrderRepository } from '../work-orders';
import { vendorWorkRepository } from '../vendor-work';
import { vendorCompletionReportRepository } from '../vendor-completion-reports/vendor-completion-report.repository';
import { vendorServiceReportRepository } from '../vendor-service-reports/vendor-service-report.repository';
import { workCompletionDocumentRepository } from '../work-completion-documents/work-completion-document.repository';
import { documentRepository } from '../documents/document.repository';
import { documentService } from '../documents/document.service';
import { recordOperationalEvent } from '../operational-events';
import { acceptanceSignOffRepository } from '../acceptance-sign-offs/acceptance-sign-off.repository';
import { findingRepository } from '../findings/finding.repository';
import { documentVersionNotFoundError } from '../document-versions/document-version.errors';
import { getPool } from '../../database';
import { withTransaction } from '../../database/transaction';
import type { PublicDocument } from '../documents/document.types';
import {
  bastAlreadyExistsError,
  bastBuildingMismatchError,
  bastContextMismatchError,
  bastDocumentNotFoundError,
  bastInvalidTransitionError,
  bastNotReadyError,
  bastNumberAlreadyExistsError,
  bastReconciliationRequiredError,
  bastWorkNotCompletedError,
  bastWorkNotFoundError,
} from './bast-document.errors';
import {
  bastDocumentRepository,
  type BastSubmissionContextRecord,
} from './bast-document.repository';
import { bastReconciliationRepository } from './bast-reconciliation.repository';
import type {
  BastReconciliationClassification,
  BastReconciliationInventory,
  BastReconciliationSeverity,
} from './bast-reconciliation.types';
import type {
  CreateBastDocumentInput,
  BastDocumentFilters,
  BastDocumentRecord,
  DecideBastDocumentInput,
  PublicBastDocument,
  PublicBastLifecycleCommandResult,
  SubmitBastDocumentInput,
} from './bast-document.types';

function toPublic(record: BastDocumentRecord, doc: PublicDocument): PublicBastDocument {
  return {
    id: record.id,
    documentId: record.documentId,
    workOrderId: record.workOrderId,
    vendorWorkId: record.vendorWorkId,
    workCompletionDocumentId: record.workCompletionDocumentId,
    vendorId: record.vendorId,
    completionReportId: record.completionReportId,
    serviceReportId: record.serviceReportId,
    acceptanceScopeType: record.acceptanceScopeType,
    bastRequirement: record.bastRequirement,
    clientId: record.clientId,
    buildingId: record.buildingId,
    contextType: record.contextType as PublicBastDocument['contextType'],
    bastNumber: record.bastNumber,
    bastDate: record.bastDate,
    acceptanceStatus: record.acceptanceStatus,
    notes: record.notes,
    fileReference: record.fileReference,
    preparedByUserId: record.preparedByUserId,
    submittedByUserId: record.submittedByUserId,
    acceptedByUserId: record.acceptedByUserId,
    submittedAt: record.submittedAt ? record.submittedAt.toISOString() : null,
    acceptedAt: record.acceptedAt ? record.acceptedAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    document: doc,
  };
}

async function getAccessibleClientIds(userId: string): Promise<string[]> {
  const contexts = await resolveBuildingsForUser(userId);
  const ids = new Set<string>();
  for (const c of contexts) if (c.client?.id) ids.add(c.client.id);
  return Array.from(ids);
}
async function assertClientAccess(userId: string, clientId: string): Promise<void> {
  const accessible = await getAccessibleClientIds(userId);
  if (!accessible.includes(clientId)) {
    const { buildingAccessDeniedError } = await import('../context-access/context-access.errors');
    throw buildingAccessDeniedError();
  }
}

async function resolveBastWorkContext(input: CreateBastDocumentInput): Promise<{
  vendorId: string | null;
  completionReportId: string | null;
  serviceReportId: string | null;
  acceptanceScopeType: 'WORK_ORDER' | 'VENDOR_WORK';
}> {
  const workOrder = await workOrderRepository.findById(input.workOrderId);
  if (!workOrder) throw bastWorkNotFoundError();
  if (workOrder.status !== 'COMPLETED') throw bastWorkNotCompletedError();
  if (workOrder.clientId !== input.clientId) throw bastContextMismatchError('BAST client does not match work client.');
  if (workOrder.buildingId !== input.buildingId) throw bastBuildingMismatchError();
  if (input.contextType === 'VENDOR' && !input.vendorWorkId) {
    throw bastContextMismatchError(
      'Vendor-context BAST requires an applicable Vendor Work.',
    );
  }

  let vendorId: string | null = null;
  let completionReportId: string | null = null;
  let serviceReportId: string | null = null;
  if (input.vendorWorkId) {
    const vendorWork = await vendorWorkRepository.findById(input.vendorWorkId);
    if (!vendorWork) throw bastWorkNotFoundError();
    if (vendorWork.workOrderId !== input.workOrderId) throw bastContextMismatchError('Vendor work does not belong to work order.');
    if (vendorWork.buildingId !== input.buildingId) throw bastBuildingMismatchError();
    if (vendorWork.status !== 'COMPLETED') throw bastWorkNotCompletedError();
    if (input.contextType === 'VENDOR' && input.sourceId && vendorWork.vendorId !== input.sourceId) {
      throw bastContextMismatchError('Vendor work vendor does not match BAST source.');
    }
    vendorId = vendorWork.vendorId;
    const [completionReport, serviceReport] = await Promise.all([
      vendorCompletionReportRepository.findByVendorWorkId(input.vendorWorkId),
      vendorServiceReportRepository.findByVendorWorkId(input.vendorWorkId),
    ]);
    if (
      completionReport &&
      (completionReport.clientId !== input.clientId ||
        completionReport.buildingId !== input.buildingId ||
        completionReport.workOrderId !== input.workOrderId)
    ) {
      throw bastContextMismatchError(
        'Completion Report does not match the canonical work context.',
      );
    }
    if (
      serviceReport &&
      (serviceReport.clientId !== input.clientId ||
        serviceReport.buildingId !== input.buildingId ||
        serviceReport.workOrderId !== input.workOrderId ||
        (serviceReport.completionReportId !== null &&
          serviceReport.completionReportId !== completionReport?.id))
    ) {
      throw bastContextMismatchError(
        'Service Report does not match the canonical work context.',
      );
    }
    completionReportId = completionReport?.id ?? null;
    serviceReportId = serviceReport?.id ?? null;
  }

  if (input.workCompletionDocumentId) {
    const workCompletion = await workCompletionDocumentRepository.findById(input.workCompletionDocumentId);
    if (!workCompletion) throw bastWorkNotFoundError();
    if (workCompletion.workOrderId !== input.workOrderId) throw bastContextMismatchError('Work completion does not belong to work order.');
    if (workCompletion.buildingId !== input.buildingId) throw bastBuildingMismatchError();
    if (workCompletion.clientId !== input.clientId) throw bastContextMismatchError('Work completion client mismatch.');
    if (input.vendorWorkId && workCompletion.vendorWorkId && workCompletion.vendorWorkId !== input.vendorWorkId) {
      throw bastContextMismatchError('Work completion vendor mismatch.');
    }
  }

  return {
    vendorId,
    completionReportId,
    serviceReportId,
    acceptanceScopeType: input.vendorWorkId ? 'VENDOR_WORK' : 'WORK_ORDER',
  };
}

export async function createBastDocument(
  input: CreateBastDocumentInput,
  actorUserId: string,
): Promise<PublicBastDocument> {
  if (input.documentType !== 'BAST') {
    throw bastContextMismatchError(
      'Canonical BAST creation requires documentType BAST.',
    );
  }
  const client = await clientRepository.findById(input.clientId);
  if (!client) {
    const { clientNotFoundError } = await import('../clients/client.errors');
    throw clientNotFoundError();
  }
  const building = await buildingRepository.findById(input.buildingId);
  if (!building) {
    const { buildingNotFoundError } = await import('../buildings/building.errors');
    throw buildingNotFoundError();
  }
  const property = await propertyRepository.findById(building.propertyId);
  if (!property || property.clientId !== input.clientId) throw bastBuildingMismatchError();
  await contextAccessService.assertBuildingAccess(actorUserId, input.buildingId);

  // Resolve and pin canonical work/report references before document creation.
  const workContext = await resolveBastWorkContext(input);

  // Validate source for context
  if (input.contextType === 'TENANT') {
    if (!input.sourceId) throw bastContextMismatchError('TENANT context requires TENANT_COMPANY source.');
    const c = await tenantCompanyRepository.findById(input.sourceId);
    if (!c) {
      const { documentSourceNotFoundError } = await import('../documents/document.errors');
      throw documentSourceNotFoundError();
    }
    if (c.clientId !== input.clientId) {
      const { documentSourceClientMismatchError } = await import('../documents/document.errors');
      throw documentSourceClientMismatchError();
    }
  }
  if (input.contextType === 'VENDOR') {
    if (!input.sourceId) throw bastContextMismatchError('VENDOR context requires VENDOR source.');
    const v = await vendorRepository.findById(input.sourceId);
    if (!v) {
      const { documentSourceNotFoundError } = await import('../documents/document.errors');
      throw documentSourceNotFoundError();
    }
    if (v.clientId !== input.clientId) {
      const { documentSourceClientMismatchError } = await import('../documents/document.errors');
      throw documentSourceClientMismatchError();
    }
  }
  if (input.contextType === 'INTERNAL' && input.sourceType && input.sourceType !== 'INTERNAL') {
    throw bastContextMismatchError('INTERNAL context only allows INTERNAL source or no source.');
  }

  // Check BAST number unique per client
  const existingBastNumber = await bastDocumentRepository.findByBastNumber(input.clientId, input.bastNumber);
  if (existingBastNumber) throw bastNumberAlreadyExistsError();

  // Check vendor_work unique (if provided)
  if (input.vendorWorkId) {
    const existingByVendorWork = await getPool().query('SELECT id FROM bast_documents WHERE vendor_work_id = $1', [input.vendorWorkId]);
    if (existingByVendorWork.rowCount && existingByVendorWork.rowCount > 0) throw bastAlreadyExistsError();
  }

  // Check document number unique
  const existingDocNumber = await documentRepository.findByClientAndNumber(input.clientId, input.documentNumber);
  if (existingDocNumber) {
    const { documentNumberAlreadyExistsError } = await import('../documents/document.errors');
    throw documentNumberAlreadyExistsError();
  }

  // Create underlying document via shared foundation
  const doc = await documentService.createDocument(
    {
      clientId: input.clientId,
      buildingId: input.buildingId,
      documentNumber: input.documentNumber,
      documentType: input.documentType,
      contextType: input.contextType,
      sourceType: input.sourceType ?? null,
      sourceId: input.sourceId ?? null,
      title: input.title,
      description: input.description ?? null,
      fileReference: input.fileReference ?? null,
      status: input.status ?? 'DRAFT',
    },
    actorUserId,
  );

  try {
    const record = await bastDocumentRepository.create({
      documentId: doc.id,
      workOrderId: input.workOrderId,
      vendorWorkId: input.vendorWorkId ?? null,
      workCompletionDocumentId: input.workCompletionDocumentId ?? null,
      vendorId: workContext.vendorId,
      completionReportId: workContext.completionReportId,
      serviceReportId: workContext.serviceReportId,
      acceptanceScopeType: workContext.acceptanceScopeType,
      clientId: input.clientId,
      buildingId: input.buildingId,
      contextType: input.contextType,
      bastNumber: input.bastNumber,
      bastDate: input.bastDate,
      notes: input.notes ?? null,
      fileReference: input.fileReference ?? null,
      preparedByUserId: actorUserId,
    });

    await recordOperationalEvent({
      clientId: record.clientId,
      buildingId: record.buildingId,
      entityType: 'BAST_DOCUMENT',
      entityId: record.id,
      eventType: 'BAST_DOCUMENT_CREATED',
      actorUserId,
      summary: `BAST ${record.bastNumber} created for work ${input.workOrderId}`,
      metadata: {
        documentId: doc.id,
        bastId: record.id,
        workOrderId: input.workOrderId,
        vendorWorkId: input.vendorWorkId ?? null,
        workCompletionDocumentId: input.workCompletionDocumentId ?? null,
        bastNumber: record.bastNumber,
      },
    });

    // BE-15H compatibility: if VENDOR context with vendorWork, create/update vendor_bast_bindings to point to this authoritative BAST
    if (input.contextType === 'VENDOR' && input.vendorWorkId) {
      try {
        const existingVbb = await getPool().query('SELECT id FROM vendor_bast_bindings WHERE vendor_work_id = $1', [input.vendorWorkId]);
        if (!existingVbb.rowCount || existingVbb.rowCount === 0) {
          // Create vendor_bast_bindings entry that points to bast_documents
          // Reuse bast_number/bast_date etc, link via bast_document_id
          const workOrder = await workOrderRepository.findById(input.workOrderId);
          if (workOrder) {
            // Need to fetch completion/service report ids for vendor work if exist
            let completionReportId: string | null = null;
            let serviceReportId: string | null = null;
            try {
              const cr = await getPool().query('SELECT id FROM vendor_completion_reports WHERE vendor_work_id = $1', [input.vendorWorkId]);
              if (cr.rowCount && cr.rows[0]) completionReportId = cr.rows[0].id;
              const sr = await getPool().query('SELECT id FROM vendor_service_reports WHERE vendor_work_id = $1', [input.vendorWorkId]);
              if (sr.rowCount && sr.rows[0]) serviceReportId = sr.rows[0].id;
            } catch {}
            await getPool().query(
              `INSERT INTO vendor_bast_bindings
                 (id, client_id, vendor_work_id, completion_report_id, service_report_id, work_order_id, building_id, bast_number, bast_date, prepared_by_user_id, notes, file_reference, bast_document_id)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
              [
                // use bast id as vendor_bast id for traceability? but generate new uuid
                // Use random uuid for vendor_bast
                (await import('node:crypto')).randomUUID(),
                input.clientId,
                input.vendorWorkId,
                completionReportId,
                serviceReportId,
                input.workOrderId,
                input.buildingId,
                input.bastNumber,
                input.bastDate,
                actorUserId,
                input.notes ?? null,
                input.fileReference ?? null,
                record.id,
              ],
            );
          }
        } else {
          // Update existing to point to new BAST
          await getPool().query('UPDATE vendor_bast_bindings SET bast_document_id = $2, updated_at = NOW() WHERE vendor_work_id = $1', [input.vendorWorkId, record.id]);
        }
      } catch (e) {
        // Compatibility is best-effort; do not fail BAST creation if vendor_bast sync fails
        // Log but continue
      }
    }

    return toPublic(record, doc);
  } catch (error) {
    // Rollback document if bast creation fails
    try {
      await getPool().query('DELETE FROM documents WHERE id = $1', [doc.id]);
    } catch {}
    if (isBastNumberUniqueViolation(error)) throw bastNumberAlreadyExistsError();
    if (isVendorWorkUniqueViolation(error)) throw bastAlreadyExistsError();
    throw error;
  }
}

export async function getBastDocument(id: string, actorUserId: string): Promise<PublicBastDocument> {
  const record = await bastDocumentRepository.findById(id);
  if (!record) throw bastDocumentNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, record.buildingId);
  const doc = await documentRepository.findById(record.documentId);
  if (!doc) throw bastDocumentNotFoundError();
  const publicDoc = documentService.toPublic(doc as any);
  return toPublic(record, publicDoc);
}

function assertSubmissionContext(
  bast: BastDocumentRecord,
  context: BastSubmissionContextRecord,
): void {
  if (
    context.documentClientId !== bast.clientId ||
    context.documentBuildingId !== bast.buildingId ||
    context.documentType !== 'BAST' ||
    context.workOrderClientId !== bast.clientId ||
    context.workOrderBuildingId !== bast.buildingId
  ) {
    throw bastContextMismatchError(
      'BAST Document and Work Order must remain in the same Client and Building.',
    );
  }
  if (context.documentStatus === 'ARCHIVED') {
    throw bastContextMismatchError('An archived BAST Document cannot be submitted.');
  }
  if (context.workOrderStatus !== 'COMPLETED') {
    throw bastWorkNotCompletedError();
  }

  if (bast.vendorWorkId) {
    if (!bast.completionReportId) {
      throw bastContextMismatchError(
        'Vendor BAST submission requires a Completion Report.',
      );
    }
    if (
      context.vendorWorkOrderId !== bast.workOrderId ||
      context.vendorWorkBuildingId !== bast.buildingId
    ) {
      throw bastContextMismatchError(
        'Vendor Work does not match the canonical BAST work context.',
      );
    }
    if (context.vendorWorkStatus !== 'COMPLETED') {
      throw bastWorkNotCompletedError();
    }
  }

  if (
    bast.completionReportId &&
    (context.completionClientId !== bast.clientId ||
      context.completionBuildingId !== bast.buildingId ||
      context.completionWorkOrderId !== bast.workOrderId ||
      context.completionVendorWorkId !== bast.vendorWorkId)
  ) {
    throw bastContextMismatchError(
      'Completion Report does not match the canonical BAST work context.',
    );
  }
  if (
    bast.completionReportId &&
    (context.completionStatus !== 'SUBMITTED' ||
      context.completionEvidenceReady !== true)
  ) {
    throw bastContextMismatchError(
      'The pinned Completion Report is not ready for BAST submission.',
    );
  }

  if (
    bast.serviceReportId &&
    (context.serviceClientId !== bast.clientId ||
      context.serviceBuildingId !== bast.buildingId ||
      context.serviceWorkOrderId !== bast.workOrderId ||
      context.serviceVendorWorkId !== bast.vendorWorkId ||
      (context.serviceCompletionReportId !== null &&
        context.serviceCompletionReportId !== bast.completionReportId))
  ) {
    throw bastContextMismatchError(
      'Service Report does not match the canonical BAST work context.',
    );
  }
  if (bast.serviceReportId && context.serviceStatus !== 'FINALIZED') {
    throw bastContextMismatchError(
      'The pinned Service Report is not finalized for BAST submission.',
    );
  }

  if (
    bast.workCompletionDocumentId &&
    (context.workCompletionClientId !== bast.clientId ||
      context.workCompletionBuildingId !== bast.buildingId ||
      context.workCompletionWorkOrderId !== bast.workOrderId ||
      (context.workCompletionVendorWorkId !== null &&
        context.workCompletionVendorWorkId !== bast.vendorWorkId))
  ) {
    throw bastContextMismatchError(
      'Work Completion Document does not match the canonical BAST work context.',
    );
  }
}

async function submitBastAttempt(
  id: string,
  input: SubmitBastDocumentInput,
  actorUserId: string,
  mode: 'submit' | 'resubmit',
): Promise<PublicBastLifecycleCommandResult> {
  const visible = await bastDocumentRepository.findById(id);
  if (!visible) throw bastDocumentNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, visible.buildingId);

  const command = await withTransaction(async (tx) => {
    const bast = await bastDocumentRepository.findByIdForUpdate(id, tx);
    if (!bast) throw bastDocumentNotFoundError();
    const expectedStatus = mode === 'submit' ? 'DRAFT' : 'REJECTED';
    if (bast.acceptanceStatus !== expectedStatus) {
      throw bastInvalidTransitionError(bast.acceptanceStatus, mode);
    }

    const context = await bastDocumentRepository.findSubmissionContext(
      bast.id,
      input.documentVersionId,
      tx,
    );
    if (!context) throw documentVersionNotFoundError();
    assertSubmissionContext(bast, context);

    if (
      await bastDocumentRepository.hasOpenReconciliationQuarantine(bast.id, tx)
    ) {
      throw bastReconciliationRequiredError();
    }

    const workOrderReview =
      await bastDocumentRepository.findLatestCompletedReview(
        'WORK_ORDER',
        bast.workOrderId,
        bast.clientId,
        tx,
      );
    if (!workOrderReview || workOrderReview.decision !== 'APPROVED') {
      throw bastNotReadyError(
        'The latest completed Work Order verification must be APPROVED.',
      );
    }

    let vendorWorkReview: { id: string; decision: string } | null = null;
    if (bast.vendorWorkId) {
      vendorWorkReview = await bastDocumentRepository.findLatestCompletedReview(
        'VENDOR_WORK',
        bast.vendorWorkId,
        bast.clientId,
        tx,
      );
      if (!vendorWorkReview || vendorWorkReview.decision !== 'APPROVED') {
        throw bastNotReadyError(
          'The latest completed Vendor Work verification must be APPROVED.',
        );
      }
      if (
        await bastDocumentRepository.hasOpenVendorRework(bast.vendorWorkId, tx)
      ) {
        throw bastNotReadyError(
          'Open Vendor Work rework must be resubmitted before BAST submission.',
        );
      }
    }

    if (mode === 'resubmit') {
      const correction =
        await bastDocumentRepository.findResubmissionCorrection(bast.id, tx);
      if (
        !correction?.findingId ||
        !['VERIFIED', 'CLOSED'].includes(correction.findingStatus ?? '')
      ) {
        throw bastNotReadyError(
          'The rejection Finding must be VERIFIED or CLOSED before BAST resubmission.',
        );
      }
      if (context.documentVersionNumber <= correction.documentVersionNumber) {
        throw bastNotReadyError(
          'BAST resubmission requires a newer immutable Document Version.',
        );
      }
    } else if (await bastDocumentRepository.hasOpenFinding(bast.id, tx)) {
      throw bastNotReadyError(
        'Open BAST acceptance Findings must be resolved before submission.',
      );
    }

    const evidenceReadiness =
      await bastDocumentRepository.getSubmissionEvidenceReadiness(bast, tx);
    if (!evidenceReadiness.requiredEvidenceReady) {
      throw bastNotReadyError(
        'Current required evidence must be satisfied before BAST submission.',
      );
    }
    const { evidenceSubmissionIds } = evidenceReadiness;
    const readinessSnapshot: Record<string, unknown> = {
      acceptanceScopeType: bast.acceptanceScopeType,
      document: {
        id: bast.documentId,
        versionId: input.documentVersionId,
        versionNumber: context.documentVersionNumber,
        status: context.documentStatus,
      },
      workOrder: {
        id: bast.workOrderId,
        status: context.workOrderStatus,
        approvedVerificationReviewId: workOrderReview.id,
      },
      vendorWork: bast.vendorWorkId
        ? {
            id: bast.vendorWorkId,
            status: context.vendorWorkStatus,
            approvedVerificationReviewId: vendorWorkReview!.id,
          }
        : null,
      workCompletionDocumentId: bast.workCompletionDocumentId,
      completionReport: bast.completionReportId
        ? {
            id: bast.completionReportId,
            status: context.completionStatus,
            evidenceReady: context.completionEvidenceReady,
          }
        : null,
      serviceReport: bast.serviceReportId
        ? { id: bast.serviceReportId, status: context.serviceStatus }
        : null,
      requiredEvidenceReady: evidenceReadiness.requiredEvidenceReady,
      evidenceSubmissionIds,
    };

    const attempt = await bastDocumentRepository.createSubmissionAttempt(
      {
        bast,
        documentVersionId: input.documentVersionId,
        workOrderVerificationId: workOrderReview.id,
        vendorWorkVerificationId: vendorWorkReview?.id ?? null,
        submittedByUserId: actorUserId,
        readinessSnapshot,
      },
      tx,
    );
    await bastDocumentRepository.addSubmissionAttemptEvidence(
      attempt.id,
      evidenceSubmissionIds,
      tx,
    );

    const submitted = await bastDocumentRepository.transitionAcceptanceStatus(
      bast.id,
      expectedStatus,
      'SUBMITTED',
      actorUserId,
      tx,
    );
    if (!submitted) {
      throw bastInvalidTransitionError(bast.acceptanceStatus, mode);
    }

    await recordOperationalEvent(
      {
        clientId: bast.clientId,
        buildingId: bast.buildingId,
        vendorWorkId: bast.vendorWorkId,
        entityType: 'BAST_DOCUMENT',
        entityId: bast.id,
        eventType: mode === 'submit' ? 'BAST_SUBMITTED' : 'BAST_RESUBMITTED',
        actorUserId,
        summary:
          mode === 'submit'
            ? `BAST ${bast.bastNumber} submitted`
            : `BAST ${bast.bastNumber} resubmitted`,
        metadata: {
          submissionAttemptId: attempt.id,
          attemptNumber: attempt.attemptNumber,
          documentId: bast.documentId,
          documentVersionId: attempt.documentVersionId,
          evidenceSubmissionIds,
        },
      },
      tx,
    );

    return {
      submissionAttemptId: attempt.id,
      documentVersionId: attempt.documentVersionId,
    };
  });

  return {
    bastDocument: await getBastDocument(id, actorUserId),
    ...command,
    acceptanceSignOffId: null,
    findingId: null,
  };
}

export async function submitBastDocument(
  id: string,
  input: SubmitBastDocumentInput,
  actorUserId: string,
): Promise<PublicBastLifecycleCommandResult> {
  return submitBastAttempt(id, input, actorUserId, 'submit');
}

export async function resubmitBastDocument(
  id: string,
  input: SubmitBastDocumentInput,
  actorUserId: string,
): Promise<PublicBastLifecycleCommandResult> {
  return submitBastAttempt(id, input, actorUserId, 'resubmit');
}

export async function decideBastDocument(
  id: string,
  input: DecideBastDocumentInput,
  actorUserId: string,
): Promise<PublicBastLifecycleCommandResult> {
  const visible = await bastDocumentRepository.findById(id);
  if (!visible) throw bastDocumentNotFoundError();
  await contextAccessService.assertBuildingAccess(actorUserId, visible.buildingId);

  const command = await withTransaction(async (tx) => {
    const bast = await bastDocumentRepository.findByIdForUpdate(id, tx);
    if (!bast) throw bastDocumentNotFoundError();
    if (bast.acceptanceStatus !== 'SUBMITTED') {
      throw bastInvalidTransitionError(bast.acceptanceStatus, 'decide');
    }

    const attempt =
      await bastDocumentRepository.findCurrentSubmissionAttemptForUpdate(
        bast.id,
        tx,
      );
    if (!attempt) {
      throw bastContextMismatchError(
        'Submitted BAST has no canonical immutable submission attempt.',
      );
    }

    const decisionStatus =
      input.decision === 'ACCEPT' ? 'ACCEPTED' : 'REJECTED';
    const signOff = await acceptanceSignOffRepository.create(
      {
        bastDocumentId: bast.id,
        handoverDocumentId: null,
        bastSubmissionAttemptId: attempt.id,
        documentVersionId: attempt.documentVersionId,
        clientId: bast.clientId,
        buildingId: bast.buildingId,
        contextType: bast.contextType,
        decision: decisionStatus,
        signerUserId: actorUserId,
        notes: input.notes ?? null,
      },
      tx,
    );

    let findingId: string | null = null;
    if (input.decision === 'REJECT') {
      const finding = await findingRepository.create(
        {
          clientId: bast.clientId,
          buildingId: bast.buildingId,
          findingNumber: `BAST-${randomUUID().replace(/-/g, '').slice(0, 16)}`,
          title: `BAST ${bast.bastNumber} rejected`,
          description:
            input.notes ??
            `Acceptance of BAST ${bast.bastNumber} was rejected.`,
          reportedByUserId: actorUserId,
        },
        tx,
      );
      const sourcedFinding = await findingRepository.updateSource(
        finding.id,
        'WORK_ORDER',
        bast.workOrderId,
        tx,
      );
      if (!sourcedFinding) {
        throw new Error('Created BAST rejection Finding could not be sourced.');
      }
      findingId = sourcedFinding.id;
      await bastDocumentRepository.createFindingLink(
        {
          bastDocumentId: bast.id,
          attemptId: attempt.id,
          acceptanceSignOffId: signOff.id,
          findingId,
          actorUserId,
          metadata: {
            workOrderId: bast.workOrderId,
            vendorWorkId: bast.vendorWorkId,
            rejectionNotes: input.notes ?? null,
          },
        },
        tx,
      );
      await recordOperationalEvent(
        {
          clientId: bast.clientId,
          buildingId: bast.buildingId,
          entityType: 'FINDING',
          entityId: findingId,
          eventType: 'FINDING_CREATED',
          actorUserId,
          summary: `Finding created from rejected BAST ${bast.bastNumber}`,
          metadata: {
            sourceType: 'WORK_ORDER',
            sourceId: bast.workOrderId,
            bastDocumentId: bast.id,
            submissionAttemptId: attempt.id,
            acceptanceSignOffId: signOff.id,
          },
        },
        tx,
      );
    }

    const decided = await bastDocumentRepository.transitionAcceptanceStatus(
      bast.id,
      'SUBMITTED',
      decisionStatus,
      actorUserId,
      tx,
    );
    if (!decided) throw bastInvalidTransitionError(bast.acceptanceStatus, 'decide');

    const eventType =
      input.decision === 'ACCEPT' ? 'BAST_ACCEPTED' : 'BAST_REJECTED';
    await recordOperationalEvent(
      {
        clientId: bast.clientId,
        buildingId: bast.buildingId,
        vendorWorkId: bast.vendorWorkId,
        entityType: 'BAST_DOCUMENT',
        entityId: bast.id,
        eventType,
        actorUserId,
        summary: `BAST ${bast.bastNumber} ${decisionStatus.toLowerCase()}`,
        metadata: {
          submissionAttemptId: attempt.id,
          documentVersionId: attempt.documentVersionId,
          acceptanceSignOffId: signOff.id,
          findingId,
          notes: input.notes ?? null,
        },
      },
      tx,
    );

    return {
      submissionAttemptId: attempt.id,
      documentVersionId: attempt.documentVersionId,
      acceptanceSignOffId: signOff.id,
      findingId,
    };
  });

  return {
    bastDocument: await getBastDocument(id, actorUserId),
    ...command,
  };
}

export async function listBastDocuments(
  filters: BastDocumentFilters,
  actorUserId: string,
): Promise<PublicBastDocument[]> {
  if (filters.buildingId) await contextAccessService.assertBuildingAccess(actorUserId, filters.buildingId);
  if (filters.clientId) await assertClientAccess(actorUserId, filters.clientId);
  if (filters.workOrderId) {
    const wo = await workOrderRepository.findById(filters.workOrderId);
    if (!wo) throw bastWorkNotFoundError();
    await contextAccessService.assertBuildingAccess(actorUserId, wo.buildingId);
  }
  if (filters.vendorWorkId) {
    const vw = await vendorWorkRepository.findById(filters.vendorWorkId);
    if (!vw) throw bastWorkNotFoundError();
    await contextAccessService.assertBuildingAccess(actorUserId, vw.buildingId);
  }
  if (filters.workCompletionDocumentId) {
    const wcd = await workCompletionDocumentRepository.findById(filters.workCompletionDocumentId);
    if (!wcd) throw bastWorkNotFoundError();
    await contextAccessService.assertBuildingAccess(actorUserId, wcd.buildingId);
  }

  const accessibleBuildingIds = await contextAccessService.getAccessibleBuildingIds(actorUserId);
  const accessibleClientIds = await getAccessibleClientIds(actorUserId);
  const records = await bastDocumentRepository.list(filters, accessibleBuildingIds, accessibleClientIds);
  const result: PublicBastDocument[] = [];
  for (const rec of records) {
    const doc = await documentRepository.findById(rec.documentId);
    if (!doc) continue;
    const publicDoc = documentService.toPublic(doc as any);
    result.push(toPublic(rec, publicDoc));
  }
  return result;
}

export async function getBastReconciliationInventory(
  buildingId: string,
  actorUserId: string,
): Promise<BastReconciliationInventory> {
  // Authorize before inventorying either source. Repository queries remain
  // Building-bound and suppress identifiers for cross-Building counterparts.
  await contextAccessService.assertBuildingAccess(actorUserId, buildingId);
  const items = await bastReconciliationRepository.inventoryBuilding(buildingId);
  const byClassification: Partial<
    Record<BastReconciliationClassification, number>
  > = {};
  const bySeverity: Record<BastReconciliationSeverity, number> = {
    INFO: 0,
    WARNING: 0,
    ERROR: 0,
  };
  for (const item of items) {
    byClassification[item.classification] =
      (byClassification[item.classification] ?? 0) + 1;
    bySeverity[item.severity] += 1;
  }
  return {
    buildingId,
    generatedAt: new Date().toISOString(),
    readOnly: true,
    summary: { total: items.length, byClassification, bySeverity },
    items,
  };
}

function isBastNumberUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const c = error as { code?: string; constraint?: string };
  return c.code === '23505' && c.constraint === 'bast_documents_client_number_unique';
}
function isVendorWorkUniqueViolation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const c = error as { code?: string; constraint?: string };
  return c.code === '23505' && c.constraint === 'bast_documents_vendor_work_unique';
}

export const bastDocumentService = {
  createBastDocument,
  decideBastDocument,
  getBastDocument,
  getBastReconciliationInventory,
  listBastDocuments,
  resubmitBastDocument,
  submitBastDocument,
};
