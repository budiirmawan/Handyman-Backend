/**
 * BE-22C — BAST via shared Document foundation.
 *
 * ONE authoritative BAST for INTERNAL / TENANT / VENDOR.
 * Reuses Work Order / Vendor Work / Work Completion (BE-22B) masters.
 * BE-15H vendor_bast_bindings points to this authoritative BAST via bast_document_id.
 */

import type { DocumentContextType, DocumentSourceType, DocumentStatus, PublicDocument } from '../documents/document.types';
import type { BastRequirement } from '../work-orders';

export const BAST_ACCEPTANCE_SCOPE_TYPES = ['WORK_ORDER', 'VENDOR_WORK'] as const;
export type BastAcceptanceScopeType =
  (typeof BAST_ACCEPTANCE_SCOPE_TYPES)[number];

export const BAST_STATUSES = ['DRAFT', 'SUBMITTED', 'ACCEPTED', 'REJECTED'] as const;
export type BastStatus = (typeof BAST_STATUSES)[number];
export function isBastStatus(v: unknown): v is BastStatus {
  return typeof v === 'string' && (BAST_STATUSES as readonly string[]).includes(v);
}

export type BastDocumentRecord = {
  id: string;
  documentId: string;
  workOrderId: string;
  vendorWorkId: string | null;
  workCompletionDocumentId: string | null;
  vendorId: string | null;
  completionReportId: string | null;
  serviceReportId: string | null;
  acceptanceScopeType: BastAcceptanceScopeType | null;
  bastRequirement: BastRequirement;
  clientId: string;
  buildingId: string;
  contextType: DocumentContextType;
  bastNumber: string;
  bastDate: string; // YYYY-MM-DD
  acceptanceStatus: BastStatus;
  notes: string | null;
  fileReference: string | null;
  preparedByUserId: string;
  submittedByUserId: string | null;
  acceptedByUserId: string | null;
  submittedAt: Date | null;
  acceptedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PublicBastDocument = {
  id: string;
  documentId: string;
  workOrderId: string;
  vendorWorkId: string | null;
  workCompletionDocumentId: string | null;
  vendorId: string | null;
  completionReportId: string | null;
  serviceReportId: string | null;
  acceptanceScopeType: BastAcceptanceScopeType | null;
  bastRequirement: BastRequirement;
  clientId: string;
  buildingId: string;
  contextType: DocumentContextType;
  bastNumber: string;
  bastDate: string;
  acceptanceStatus: BastStatus;
  notes: string | null;
  fileReference: string | null;
  preparedByUserId: string;
  submittedByUserId: string | null;
  acceptedByUserId: string | null;
  submittedAt: string | null;
  acceptedAt: string | null;
  createdAt: string;
  updatedAt: string;
  document: PublicDocument;
};

export type SubmitBastDocumentInput = {
  documentVersionId: string;
};

export type BastDecision = 'ACCEPT' | 'REJECT';

export type DecideBastDocumentInput = {
  decision: BastDecision;
  notes?: string | null;
};

export type PublicBastLifecycleCommandResult = {
  bastDocument: PublicBastDocument;
  submissionAttemptId: string;
  documentVersionId: string;
  acceptanceSignOffId: string | null;
  findingId: string | null;
};

export type CreateBastDocumentInput = {
  clientId: string;
  buildingId: string;
  contextType: DocumentContextType;
  sourceType?: DocumentSourceType | null;
  sourceId?: string | null;
  title: string;
  description?: string | null;
  fileReference?: string | null;
  status?: DocumentStatus;
  documentNumber: string;
  documentType: string;
  workOrderId: string;
  vendorWorkId?: string | null;
  workCompletionDocumentId?: string | null;
  bastNumber: string;
  bastDate: string;
  notes?: string | null;
};

export type BastDocumentFilters = {
  workOrderId?: string;
  vendorWorkId?: string;
  workCompletionDocumentId?: string;
  buildingId?: string;
  contextType?: DocumentContextType;
  acceptanceStatus?: BastStatus;
  clientId?: string;
  bastNumber?: string;
};
